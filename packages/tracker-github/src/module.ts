/**
 * The GitHub tracker module: the platform's listener, adapter and
 * **tracker**. Everything GitHub-shaped — the webhook route and its seal,
 * the GraphQL board, the status comment and its hidden state — lives behind
 * `./tracker.ts`. The host's **orchestrator** owns a run: its durable
 * record, its OpenCode session, the worker tools and the rule that only a
 * tool call ends it. We answer for the **stages** (`@aivi/plugin`, work):
 * `initWork` opens the ticket's status comment — GitHub gives an app no
 * working session (apps cannot be assignees, proven 403), so the comment
 * `startSession` creates **is** the conversation (D6) — and we answer with
 * the ticket's **summary** and a generated branch (D8); `ready` joins the
 * OpenCode session to that pair; `question` and `plan` render as they
 * arrive; `endWork` says the closing words in our order — the final comment
 * first, then the frozen status comment, then the cleared `Agent` field —
 * and only after we speak does the orchestrator move the ticket and return
 * the lease. Our failures stay ours: the closing retries on the next wake
 * and at boot, decided against GitHub's real state, never a flag in
 * somebody else's database, and a person hears of a failed closing the
 * moment it fails — the human label rides the ticket, help is on the way. A
 * person's message into a worker's run never passes through the orchestrator
 * either: we post it straight into the OpenCode session — an answer when a
 * form is open, a steer otherwise. A hand-set `Agent` value gets one fixed
 * answer: work reaches us through the board, not through the field. What
 * stays ours besides all that is the assistant — the conversation a person
 * brings us directly, which still rides the channel machinery until the
 * channels reform.
 */
import { errorMessage, laneOf, type Project, type ProjectLane } from '@aivi/core';
import {
  ChannelEngine,
  ConversationStore,
  createTurnRunner,
  isTerminal,
  stopTurn as stopRunningTurn,
} from '@aivi/host';
import type { AiviModule, AiviServices, RunView, Store, Tracker } from '@aivi/plugin';
import type { ChannelDelivery, ChannelPlatform, Turn } from '@aivi/plugin/channel';
import type { Platform, TrackerChange, TrackerCommentKind, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import type { GithubClient } from './client.ts';
import { githubClient, isGoneError } from './client.ts';
import type { GithubConfig } from './config.ts';
import { assistantAgent, MODULE_ID } from './config.ts';
import { createGithubDesk } from './desk.ts';
import { RunLinks } from './links.ts';
import { githubRepoCollisions, projectForIssue, projectGithub } from './projects.ts';
import { RunProgress } from './runprogress.ts';
import { GITHUB_FEED, GithubPlatform, registerWebhookRoute } from './tracker.ts';
import type { GithubBoard } from './work.ts';
import { githubBoard, issueDossier } from './work.ts';

/**
 * The platform: a ticket is an assistant conversation, a status comment is a
 * run conversation — `github:owner/repo#47` and `github:owner/repo#47:c123`.
 * Assistant turns have effects beyond their reply, so a restart mid-turn
 * blocks instead of discarding.
 */
export const GITHUB: ChannelPlatform = {
  // The **platform** id, and so the table prefix and the session origin. It
  // says who a conversation is on, which is GitHub, not which package
  // speaks for it. The module's own id — `plugins.tracker-github`, the log
  // category — is `MODULE_ID`, and the two are deliberately different.
  id: GITHUB_FEED,
  label: 'GitHub',
  replyLimit: 65_000,
  effects: 'work',
  describeSpeaker: turn => `[GitHub follow-up from ${turn.name}]`,
  notices: {
    failed: 'This worker hit an error',
    stopped: 'Stopped at your request. The OpenCode session is left as it is for inspection.',
    notStarted: 'I could not reach my agent runtime, so nothing was started. Send another message to try again.',
    offline: 'aivi is going offline (a restart or shutdown). This assistant turn was stopped.',
    offlineMidReply: 'aivi is going offline while posting my answer; it may be incomplete.',
    offlineQueued:
      'aivi is going offline (a restart or shutdown). This request stays queued and starts when it is back.',
    blocked:
      'I could not finish this and cannot tell whether the agent stopped. An operator has been notified; the issue waits until they resolve it.',
  },
};

export function openGithubStore(store: Store): ConversationStore {
  // Every conversation is bound individually; the module binding never changes.
  return new ConversationStore(store, GITHUB, 'github');
}

/** Where the module's tracker comes from: GitHub's adapter by default, a
 *  fake tracker in a test of the decisions below. The concrete class is the
 *  point — the closing speaks the GitHub-only words (`markClosing`,
 *  `freezeStatus`) the neutral contract does not carry. */
export type MakeTracker = (services: AiviServices) => Promise<GithubPlatform>;

/** The board, pull-shaped, for the orchestrator's walk; a test hands its own
 *  lanes the way it hands its own tracker. */
export type MakeBoard = (services: AiviServices, tracker: GithubPlatform) => GithubBoard;

export function createGithubModule(config: GithubConfig, makeTracker?: MakeTracker, makeBoard?: MakeBoard): AiviModule {
  return {
    id: MODULE_ID,
    start: services =>
      startGithub(
        config,
        services,
        makeTracker ??
          (async ({ loaded, log }) => {
            const { client, webhookSecret } = await githubClient(log.getChild(MODULE_ID));
            const platform = new GithubPlatform(loaded, client, webhookSecret, log.getChild(MODULE_ID), config.trust);
            // Boards first: a missing `Status` or `Agent` field is said now,
            // with the remedy, not mid-run.
            await platform.warm();
            return platform;
          }),
        makeBoard ?? ((s, tracker) => githubBoard(config, s, tracker.client, s.log.getChild(MODULE_ID))),
      ),
  };
}

/** The branch a ticket works on (D8): GitHub names none, so the tracker
 *  generates `aivi/<number>-<slug>` — the words a worktree lane checks out,
 *  human-readable and stable across retries. */
export function branchFor(ticketId: string, title: string): string {
  const number = ticketId.slice(ticketId.indexOf('#') + 1);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug ? `aivi/${number}-${slug}` : `aivi/${number}`;
}

async function startGithub(
  config: GithubConfig,
  services: AiviServices,
  makeTracker: MakeTracker,
  makeBoard: MakeBoard,
) {
  const log = services.log.getChild(MODULE_ID);
  const collisions = githubRepoCollisions(services.loaded);
  if (collisions.length) throw new Error(`GitHub config: ${collisions.join('; ')}`);
  const store = openGithubStore(services.store);
  const links = new RunLinks(services.store);
  /** One progress follower per run: the worker's OpenCode session mirrored
   *  into the ticket's status comment (docs: the one edited line that says
   *  what the worker is doing). It starts with the pair at `ready`, pauses
   *  while a question awaits a person, resumes when the answer lands, and
   *  stops before the closing so the closing is the last word. */
  const runProgress = new Map<string, RunProgress>();
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { blocked: interrupted.length });

  // The adapter takes the whole platform in: the app, the credential, the
  // route, the seal.
  const tracker = await makeTracker(services);
  const client: GithubClient = tracker.client;
  // The board the eligibility walk reads: which projects this installation
  // speaks for, what sits in a lane, how a ticket enters one.
  const board = makeBoard(services, tracker);
  // The ticket desk: GitHub's answers for the `aivi_ticket_*` tools the
  // *host* claims (packages/host/src/ticket-desk.ts) — this module builds no
  // tools and claims nothing; the desk travels on the Tracker registered
  // below. The seeded OpenCode config still denies every action to every
  // agent, and an agent file that works tickets allows the ones it speaks.
  const desk = createGithubDesk(services.loaded, config, tracker);

  const abort = new AbortController();
  let engine: ChannelEngine | undefined;
  const stop = () => {
    abort.abort();
    engine?.stop();
  };
  services.signal.addEventListener('abort', stop, { once: true });
  const teardown = async () => {
    stop();
    for (const follower of runProgress.values()) void follower.stop();
    try {
      await engine?.shutdown();
    } finally {
      services.signal.removeEventListener('abort', stop);
    }
  };

  const say = (conversation: string, text: string, kind: TrackerCommentKind) =>
    tracker.comment(conversation, text, kind).catch(error => log.warn('notify.failed', { error }));

  try {
    const home = services.loaded.path.replace(/\/[^/]*$/, '');
    // The assistant's turn machinery. A worker is NOT here: the orchestrator
    // creates the worker's own OpenCode session and drives it; only the
    // conversations people bring us directly ride this engine.
    const ask = await createTurnRunner(
      GITHUB,
      { agent: 'unbound', directory: home },
      services.loaded,
      services.opencode,
      services.events,
      services.store,
      services.log,
    );
    // A real comment the engine can edit by id and delete when the answer
    // lands is GitHub's honest stand-in for Linear's ephemeral activity: the
    // placeholder comment lives while the turn runs and is gone when it ends.
    const delivery: ChannelDelivery = {
      send: async (conversation, text) => {
        const id = await tracker.comment(conversation, text, 'answer');
        // The assistant's marks (D10): the rocket replaces the eyes once the
        // answer lands. A status surface only — no run state rides it, and
        // GitHub makes the pair idempotent per reactor.
        const ref = tracker.ticketOf(conversation);
        if (ref)
          await Promise.all([
            client.addReaction(ref, 'rocket').catch(error => log.warn('reaction.failed', { error })),
            client.removeOwnReaction(ref, 'eyes').catch(error => log.warn('reaction.failed', { error })),
          ]);
        return id;
      },
      placeholder: async (conversation, text) => tracker.comment(conversation, text, 'progress'),
      edit: async (conversation, id, text) => {
        const ref = tracker.ticketOf(conversation);
        if (!ref) return;
        await client.updateComment(ref, Number(id), text);
      },
      delete: async (conversation, id) => {
        const ref = tracker.ticketOf(conversation);
        if (!ref) return;
        await client.deleteComment(ref, Number(id));
      },
      notice: async (conversation, text) => {
        await tracker.comment(conversation, text, 'outcome');
      },
    };
    engine = new ChannelEngine(
      store,
      { resource: config.resource, maxConcurrent: 8 },
      services.loaded.config.scheduler,
      ask,
      delivery,
      {
        log, // the module's own child, so engine records carry the module category
        onRelease: services.wake,
        onFailure: services.fail,
        progress: { mode: config.progress, events: services.events },
      },
    );

    const refuse = async (conversation: string, why: string) => {
      log.info('session.refused', { conversation, why });
      await say(conversation, why, 'outcome');
    };

    /** A hand-set `Agent` value nothing can run gets one plain, fixed answer:
     *  the assistant holds conversations people bring it, it does not
     *  improvise over a job the config never claimed. The value is cleared
     *  first — the app must not sit on the ticket as a worker it cannot be,
     *  and the field blacklists the ticket from the walk. */
    const unclaimed = async (issue: TrackerIssue, why: string) => {
      log.info('session.unclaimed', { issue: issue.identifier, why });
      await tracker.unassign(GITHUB_FEED, issue.id).catch(error => log.warn('delegate.undone', { error }));
      await tracker
        .notify(
          GITHUB_FEED,
          issue.id,
          `I looked into ${issue.identifier}, and there is nothing I can do at this time: ${why} I have cleared the \`${'Agent'}\` field — comment on the ticket if you want to talk about it.`,
        )
        .catch(error => log.warn('notify.failed', { error }));
    };

    /**
     * The closings we owe GitHub: every ended run whose closing has not
     * landed. A failed closing informs a person the moment it fails — the
     * human label rides the ticket and the ticket says why — and stays owed
     * to the next wake and the next boot; the label stands until a person
     * removes it. Nothing here lives in the orchestrator's record: delivery
     * is ours, so the outbox is ours too.
     */
    const closings = new Map<string, RunView>();
    /** Runs whose failure a person has already been told about: the help is
     *  on the way once, never repeated on every failed retry. */
    const helped = new Set<string>();

    /** Our platform's word for "a person, please": the human label. */
    const markForHuman = async (conversation: string, ticketId: string): Promise<void> => {
      try {
        await tracker.apply(conversation, ticketId, { kind: 'label', label: config.humanLabel, on: true });
      } catch (error) {
        log.warn('help.label.failed', { ticket: ticketId, error });
      }
    };

    /** A worker the dispatcher could not kill, or a worker a person asked
     *  to stop while OpenCode would not answer the interrupt (ruled
     *  2026-10-02; the stop's twin 2026-10-03): the ticket carries the
     *  human label and says plainly that a worker may still be running —
     *  help is on the way, and a person goes looking. Said once: `helped`
     *  is the memory that this closing already cried it. */
    const tellUnconfirmed = async (runId: string, conversation: string, entry: RunView): Promise<void> => {
      if (
        entry.outcome?.kind !== 'failure' ||
        (entry.outcome.code !== 'kill-unconfirmed' && entry.outcome.code !== 'stop-unconfirmed') ||
        helped.has(runId)
      )
        return;
      helped.add(runId);
      await say(
        conversation,
        entry.outcome.code === 'stop-unconfirmed'
          ? 'A person asked me to stop this worker, but my agent runtime would not answer the interrupt — it may still be running. I have marked this issue for a person.'
          : 'The dispatcher could not stop my worker session, so one may still be loose. I have marked this issue for a person.',
        'outcome',
      );
      await markForHuman(conversation, entry.ticketId);
    };

    /**
     * One closing, driven against GitHub's real state: the **final comment
     * first** — it is the word people read, and its hidden tie to the status
     * comment is what makes a retry say it once — then the **frozen status
     * comment**, then the **`Agent` value**, which **every ending clears**:
     * the value means "aivi is working this ticket", and a finished run
     * works it no more — leaving it set would blacklist the ticket from the
     * walk (composed 2026-10-02 with the eligibility rule), while the status
     * comment stays on the ticket as the readable trail either way. The lane
     * move is not here: it is the orchestrator's decision and its debt,
     * performed through `moveTo` after this returns.
     */
    const driveClosing = async (runId: string): Promise<void> => {
      const entry = closings.get(runId);
      if (!entry) return;
      const link = entry.sessionId ? links.byOpencodeSession(entry.sessionId) : undefined;
      if (!link) {
        closings.delete(runId);
        return void log.error('closing.unpaired', { run: runId, ticket: entry.ticketId });
      }
      const conversation = tracker.idFor(link.agentSession);
      const success = entry.outcome?.kind === 'success';
      const words = success ? entry.outcome.summary : (entry.outcome?.reason ?? 'The run ended without an outcome.');
      try {
        if (!(await tracker.resultShown(conversation))) await tracker.markClosing(conversation, words, success);
        await tracker.freezeStatus(conversation, success ? '**Done**' : '**Failed**');
        await tellUnconfirmed(runId, conversation, entry);
        await tracker.unassign(conversation, entry.ticketId).catch(error => log.warn('delegate.undone', { error }));
        closings.delete(runId);
        links.closingLanded(link.agentSession); // settled: no boot asks GitHub about this pair again
        log.info('run.caughtup', { run: runId, ticket: entry.ticketId });
      } catch (error) {
        // A deleted ticket takes its status comment with it, and GitHub then
        // answers every step with 404. The closing is owed to a surface that
        // no longer exists: drop the debt, retire the pair, and say it
        // plainly once. The person deleted the ticket; they need no help
        // label on a grave, and a boot that re-asked GitHub about a dead
        // pair every time would only teach the log to be unread.
        if (isGoneError(error)) {
          closings.delete(runId);
          links.drop(link.agentSession);
          log.warn('closing.dropped', { run: runId, ticket: entry.ticketId, error });
          return;
        }
        // The closing failed: the person hears it NOW — the operator must be
        // informed — and the closing stays owed: the next wake and the next
        // boot try again, and each step asks GitHub's real state first so a
        // half-landed ceremony finishes without saying anything twice.
        if (!helped.has(runId)) {
          helped.add(runId);
          log.error('closing.failed', { run: runId, ticket: entry.ticketId, error });
          await say(
            conversation,
            `I could not finish reporting this run: ${errorMessage(error)}. The issue is marked for a person — help is on the way.`,
            'outcome',
          );
          await markForHuman(conversation, entry.ticketId);
        } else log.warn('closing.retry.failed', { run: runId, error });
        throw error;
      }
    };

    const retryClosings = async (): Promise<void> => {
      for (const runId of [...closings.keys()]) await driveClosing(runId).catch(() => {});
    };

    /** The conversation a stage speaks through: the pair `initWork` opened
     *  and `ready` attached. A stage that cannot find it says so — the
     *  render is lost, the log is not, and the tracker's own retries answer. */
    const conversationOf = (run: RunView): string => {
      const link = run.sessionId ? links.byOpencodeSession(run.sessionId) : undefined;
      if (!link) throw new Error(`run ${run.id} has no status-comment pair to speak through`);
      return tracker.idFor(link.agentSession);
    };

    /**
     * GitHub as the orchestrator knows it: one `Tracker` — the board the
     * walk reads and the stages every run of ours walks through
     * (docs/orchestrator.md). The lifecycle stages the orchestrator awaits
     * (`initWork`, `endWork`) fail visibly; the renders it fires and forgets
     * (`ready`, `question`, `plan`) throw into its log and are retried, if
     * they matter, by us. `startWork` we answer with silence on purpose:
     * the follower is already watching the session from `ready`, and a
     * second word would only repeat the first.
     */
    const work: Tracker = {
      id: MODULE_ID,
      projects: board.projects,
      tickets: board.tickets,
      moveTo: board.moveTo,
      desk,
      /** Where the ticket sits right now, in the walk's own read: gone means
       *  deleted or off the board — never on a board this project does not
       *  speak, which is the repository's own routing answer. The
       *  orchestrator asks before every ending move (ruled 2026-10-02). */
      ticketLane: async (projectId, ticketId) => {
        const routed = projectGithub(services.loaded, projectId);
        if (!routed) return undefined;
        const words = await board.issue(ticketId).catch((error: unknown) => {
          if (isGoneError(error)) return undefined; // deleted says the same in other words
          throw error;
        });
        if (!words || !routed.repos.includes(words.teamId)) return undefined;
        return words.stateName || undefined; // on a mapped repo, off the board: no lane
      },
      /** The status comment is the whole opening (D6): GitHub makes no
       *  working session for an app, so we open the ticket's one visible
       *  word ourselves — the first line stands, the machine state rides
       *  under it (D7) — and record the pair **before** anything else can
       *  arrive. The branch is ours too (D8): GitHub names none, the walk's
       *  worktree lanes need one, so the tracker generates it. */
      initWork: async run => {
        const issue = await board.issue(run.ticketId);
        if (!issue) throw new Error('the ticket is gone from the board (deleted by a person)');
        // A run that dies here has no conversation to speak through, and
        // silence was seven failures (live, 2026-10-02): the ticket itself
        // gets the plain word before the run fails. If even the comment
        // cannot land, the log carries it — never nothing.
        const visible = async (why: string): Promise<never> => {
          await tracker
            .notify(GITHUB_FEED, run.ticketId, `I could not start work on this ticket: ${why}`)
            .catch(error => log.warn('initWork.notice.failed', { error }));
          throw new Error(why);
        };
        let session: string | null;
        try {
          session = await tracker.startSession(GITHUB_FEED, run.ticketId);
        } catch (error) {
          return visible(`the status comment failed: ${errorMessage(error)}`);
        }
        if (!session)
          return visible(
            'GitHub made no status comment for the ticket. If aivi still holds the Agent field as its own on this board, clear it before asking again.',
          );
        links.bind(session, run.ticketId);
        return { summary: issueDossier(issue), branch: branchFor(run.ticketId, issue.title) };
      },
      ready: run => {
        if (!run.sessionId) return void log.warn('ready.sessionless', { run: run.id });
        // Absent means the pair was already attached: a replay, said never.
        if (!links.attach(run.ticketId, run.sessionId)) log.debug('ready.replayed', { run: run.id });
        // The progress stream starts with the pair it can speak through:
        // while the run works, its session is the one edited status line.
        if (config.progress === 'silent' || !tracker.progress) return;
        const follower =
          runProgress.get(run.id) ??
          new RunProgress(tracker, conversationOf(run), run.sessionId, {
            mode: config.progress,
            events: services.events,
            log,
          });
        runProgress.set(run.id, follower);
        follower.start();
      },
      question: async (run, question) => {
        // Parked: nothing happens while a person thinks, and an idle
        // follower would only refresh a line that stands still. Guarded so
        // a run that never streamed says nothing a beat later than before.
        const follower = runProgress.get(run.id);
        if (follower) await follower.stop();
        await tracker.ask(conversationOf(run), question);
      },
      plan: async (run, plan) => {
        await tracker.plan(conversationOf(run), plan);
      },
      endWork: async run => {
        // The closing is the run's last word: the progress stream falls
        // silent before it, never after.
        const follower = runProgress.get(run.id);
        if (follower) await follower.stop();
        runProgress.delete(run.id);
        if (closings.has(run.id)) return; // the stage and the boot pass may race for one run
        closings.set(run.id, run);
        await driveClosing(run.id);
      },
    };
    services.orchestrator.addTracker(work);

    /**
     * The assistant: who people reach directly. A hand-set `Agent` value
     * nothing claims is un-taken here; the assistant's response is the trail.
     */
    const startAssistant = async (
      issue: TrackerIssue,
      project: Project | undefined,
      conversation: string,
      promptContext?: string,
    ) => {
      store.bind(conversation, {
        agent: assistantAgent(services.loaded.config.plugins['tracker-github'] as GithubConfig | undefined),
        directory: project ? project.directory : home,
        project: project?.id ?? null,
      });
      await say(conversation, `One moment — reading ${issue.identifier}.`, 'progress');
      // The assistant's marks (D10): eyes while it works, swapped for the
      // rocket when the answer lands. Status surface only.
      await client.addReaction(issue.id, 'eyes').catch(error => log.warn('reaction.failed', { error }));
      // Facts only: who is talking and what was brought. How the assistant
      // behaves with them is the agent file's, the whole boundary.
      const situation = `[platform: github; issue: ${issue.identifier} "${issue.title}"; project: ${project?.id ?? 'none'}; came by: a person brought you the issue]`;
      const text = [situation, promptContext ?? issueDossier(issue)].join('\n\n');
      const { session } = tracker.parts(conversation);
      store.enqueue(
        {
          id: `created:${session}`,
          channel: conversation,
          user: tracker.ownerOf(conversation),
          name: 'GitHub',
          text,
        },
        100,
      );
    };

    /** End the assistant turn in `conversation` because the person asked; the session stays. */
    const stopAssistant = async (conversation: string, why: string) => {
      const result = await stopRunningTurn(engine!, services.opencode, conversation);
      if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
      // The engine's stopped notice follows for a running turn; queued-only conversations hear this one.
      if (!result.stopped) await say(conversation, why, 'outcome');
      else await say(conversation, why, 'note');
      log.info('assistant.stopped', { conversation, why });
    };

    /**
     * A ticket brought to us with nothing known about it. Routing is
     * deterministic, from the issue re-read: a redelivery finds the bound
     * conversation or the live run and stops; a deleted ticket gets nothing
     * at all; the human label refuses for any agent — the tracker decides
     * what needs-human looks like on its platform; a **hand-set `Agent`
     * value** gets one fixed refusal — work reaches me through the board,
     * and the only value my own run sets is folded away by the live-run
     * guard above; and what a person brings us — a comment on the ticket,
     * GitHub's only way in — lands on the assistant, the project's
     * configured assistant, in the fixed context of a project (ruled
     * 2026-10-02).
     */
    const onBrought = async (conversation: string, issueId: string, said?: string) => {
      if (store.has(conversation) || (issueId && services.orchestrator.activeRun(MODULE_ID, issueId))) return; // a redelivery
      if (!issueId) return refuse(conversation, 'I only work on issues; this has none.');
      const issue = await tracker.issue(GITHUB_FEED, issueId);
      if (issue.archived) return log.debug('session.archived', { issue: issue.identifier });
      if (issue.labels.some(l => l.name === config.humanLabel))
        return refuse(
          conversation,
          `${issue.identifier} carries the \`${config.humanLabel}\` label, so a person handles it. Remove the label to let me work on it.`,
        );
      const routed = projectForIssue(services.loaded, { repo: issue.teamId });
      if (issue.delegateId === tracker.ownerOf(GITHUB_FEED)) {
        // A hand-set Agent value not initiated by us (ruled 2026-10-02): our
        // own `initWork` value was folded away by the live-run guard above,
        // so whoever named us here did it by hand. One fixed refusal — the
        // value cleared, the answer plain — whatever the lane maps: work
        // reaches me through the board.
        if (issue.completed)
          return refuse(conversation, `${issue.identifier} is already finished as far as work goes; nothing to start.`);
        return void (await unclaimed(
          issue,
          'work reaches me through the board, not through the `Agent` field: I start a worker myself once the ticket sits in a lane I work.',
        ));
      }
      // A person addressing us is a conversation the assistant holds,
      // mapped lanes or not.
      await startAssistant(
        issue,
        routed?.project,
        conversation,
        said ? `${issueDossier(issue)}\n\nThe person wrote on the ticket: ${said}` : undefined,
      );
      engine?.tick();
    };

    /** A stop signal: the run's stop goes to a person's hands on the board
     *  *before* the run ends (ruled 2026-10-03) — "not that one again" is
     *  the human label's memory, never one in a database — and the ending
     *  clears the `Agent` value and wakes the walk in the same breath. A
     *  stop with no run stops the assistant's own turn, if one is running. */
    const onStopSignal = async (conversation: string, run: RunView | undefined): Promise<void> => {
      if (run) {
        await markForHuman(GITHUB_FEED, run.ticketId);
        await services.orchestrator.stop(run.id, `A person asked to stop ${run.ticketId} from the ticket.`);
        return;
      }
      if (!store.has(conversation))
        return refuse(
          conversation,
          'I do not know this conversation (it started before aivi did, or its state is gone). Comment on the ticket again.',
        );
      const result = await stopRunningTurn(engine!, services.opencode, conversation);
      if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
      if (!result.stopped) await say(conversation, 'Nothing is running right now.', 'answer');
    };

    /** An answer to a pending form: the orchestrator owns its delivery — the
     *  slot may have been given back while the person thought, and an answer
     *  that finds no capacity **reacquires** it, in the session's own pool,
     *  queue included, before the same session resumes. OpenCode first, the
     *  books second (ruled 2026-10-03): the worker gets the text, then the
     *  form closes as the record. */
    const deliverAnswer = async (conversation: string, run: RunView, text: string, formId: string): Promise<void> => {
      let outcome: Awaited<ReturnType<typeof services.orchestrator.answer>>;
      try {
        outcome = await services.orchestrator.answer(run.sessionId!, text, formId);
      } catch (error) {
        // OpenCode would not take the answer. Nothing moved — the run
        // is still parked, the question still stands — and the person
        // hears that now, in these words, not by silence.
        log.warn('answer.delivery.failed', { run: run.id, error });
        return refuse(
          conversation,
          'I could not reach my agent runtime to wake the worker — the question still stands; answer it again once the runtime is back.',
        );
      }
      if ('refused' in outcome)
        return refuse(
          conversation,
          'The worker’s slot is gone and no capacity is free to wake it again — the pool behind its lane is full and its one queue place is taken. The question still stands: answer it again once a slot opens.',
        );
      if ('queued' in outcome)
        await say(
          conversation,
          'I have your answer. No slot is free to wake that worker yet, so it wakes the moment one opens.',
          'progress',
        );
      // Work resumes (now or when the slot opens): the progress stream resumes with it.
      runProgress.get(run.id)?.start();
      return log.info('run.answered', { run: run.id, form: formId, ...outcome });
    };

    /** An interjection steers (ruled 2026-10-01): the message lands between
     *  turns and steers what comes next. With no turn to steer, the same
     *  message queues instead; when both ways fail the person is told the
     *  message did not land — never silence for a message that is gone. */
    const steerInterjection = async (
      conversation: string,
      run: RunView,
      client2: Awaited<ReturnType<typeof services.opencode>>,
      text: string,
    ): Promise<void> => {
      try {
        await client2.session.prompt({
          sessionID: run.sessionId!,
          id: `msg_${crypto.randomUUID()}`,
          text,
          delivery: 'steer',
        });
        return log.info('run.interjected', { run: run.id });
      } catch (error) {
        log.warn('run.steer.failed', { run: run.id, error });
        try {
          await client2.session.prompt({
            sessionID: run.sessionId!,
            id: `msg_${crypto.randomUUID()}`,
            text,
            delivery: 'queue',
          });
          return log.info('run.interjected.queued', { run: run.id });
        } catch (queueError) {
          // Both ways in failed. The delivery was acknowledged to GitHub
          // already, so nothing resends it: if the person hears nothing the
          // message is gone with only a log line. The conversation hears
          // that it did not land, and can say it again.
          log.error('run.interjection.lost', { run: run.id, error: queueError });
          return refuse(
            conversation,
            'I could not carry that message — my agent runtime would not take it, to steer or to queue. Say it again.',
          );
        }
      }
    };

    /** The follow-up a finished run's conversation gets: the assistant
     *  answers in its own session, with the ticket read afresh. */
    const followUp = async (conversation: string, record: RunView, text: string): Promise<void> => {
      const issue = await tracker.issue(GITHUB_FEED, record.ticketId);
      const routed = projectForIssue(services.loaded, { repo: issue.teamId });
      await startAssistant(
        issue,
        routed?.project,
        conversation,
        `[follow-up: the run on this ticket ended (${record.state})${record.outcome ? `: ${record.outcome.kind === 'success' ? record.outcome.summary : record.outcome.reason}` : ''}. The person now says: ${text}]`,
      );
      engine?.tick();
    };

    /**
     * A person's message on a ticket — GitHub's only way into a
     * conversation. If a run lives on the ticket, the **orchestrator is not
     * in this path**: we post into the OpenCode session ourselves, and the
     * open form is the discriminator — a pending form makes the message an
     * ANSWER (the worker gets the text, the form closes as the record;
     * OpenCode resumes the session), its absence an INTERJECTION steered
     * into the running turn — never read from the words. Otherwise the
     * assistant holds the conversation, and a follow-up to a finished run is
     * the assistant answering about a ticket it can read afresh. What
     * nothing knows is a ticket brought to us.
     */
    const onPrompted = async (event: Extract<TrackerEvent, { kind: 'prompted' }>) => {
      const conversation = event.conversation;
      const ref = tracker.ticketOf(conversation);
      if (!ref) return refuse(conversation, 'I do not know this conversation.');
      const record =
        services.orchestrator.activeRun(MODULE_ID, ref) ??
        (() => {
          const link = links.byTicket(ref);
          return link?.opencodeSession ? services.orchestrator.runBySession(link.opencodeSession) : undefined;
        })();
      // Only a run still live on the ticket makes this a working session. A
      // finished one is the assistant's ground: a message into a completed
      // conversation is a follow-up, not an answer or an interjection.
      const run = record && !isTerminal(record.state) ? record : undefined;
      if (event.signal === 'stop') return onStopSignal(conversation, run);
      const text = event.body?.trim();
      if (!text) return;
      if (run?.sessionId) {
        const opencode = await services.opencode();
        const [form] = await opencode.session.form.list({ sessionID: run.sessionId });
        if (form) return deliverAnswer(conversation, run, text, form.id);
        return steerInterjection(conversation, run, opencode, text);
      }
      if (store.has(conversation)) {
        store.enqueue(
          { id: event.id, channel: conversation, user: GITHUB_FEED, name: 'a person on GitHub', text },
          100,
        );
        return engine?.tick();
      }
      // The ticket belongs to a run that has ended: a person continuing a
      // finished conversation is talking to us.
      if (record && isTerminal(record.state)) return followUp(conversation, record, text);
      // Nothing knows this ticket: a person brought it to us.
      return onBrought(conversation, ref, text);
    };

    /** The assistant conversations the update orphaned: the human label, a
     *  lane move or an `Agent` change each stops only its own kind of change. */
    const stopOrphans = async (
      pending: string[],
      issue: TrackerIssue,
      lane: ProjectLane | undefined,
      human: boolean,
      changed: TrackerChange[],
    ) => {
      for (const conversation of pending) {
        const workerAgent = store.sessionOf(conversation)?.agent;
        if (issue.archived && changed.includes('archive'))
          await stopAssistant(conversation, `Stopped: ${issue.identifier} was deleted; there is no work to do.`);
        else if (human && changed.includes('labels'))
          await stopAssistant(
            conversation,
            `Stopped: \`${config.humanLabel}\` was added to ${issue.identifier}; a person takes over.`,
          );
        else if (changed.includes('state') && lane?.agent !== workerAgent)
          await stopAssistant(
            conversation,
            `Stopped: ${issue.identifier} moved to "${issue.state.name}", which is not my lane.`,
          );
        else if (changed.includes('delegate') && issue.delegateId !== tracker.ownerOf(GITHUB_FEED))
          await stopAssistant(conversation, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
      }
    };

    /** The run the update orphaned — same three reasons: interrupt the
     *  worker and end the run cancelled; the ending's catch-up says so in
     *  the status comment. */
    const stopOrphanRun = async (
      issue: TrackerIssue,
      lane: ProjectLane | undefined,
      human: boolean,
      changed: TrackerChange[],
    ) => {
      const run = services.orchestrator.activeRun(MODULE_ID, issue.id);
      if (!run) return;
      const link = run.sessionId ? links.byOpencodeSession(run.sessionId) : undefined;
      if (issue.archived && changed.includes('archive'))
        await services.orchestrator.stop(run.id, `Stopped: ${issue.identifier} was deleted; there is no work.`);
      else if (human && changed.includes('labels'))
        await services.orchestrator.stop(
          run.id,
          `Stopped: \`${config.humanLabel}\` was added to ${issue.identifier}; a person takes over.`,
        );
      else if (changed.includes('state') && lane?.agent !== run.agent)
        await services.orchestrator.stop(
          run.id,
          `Stopped: ${issue.identifier} moved to "${issue.state.name}", which is not my lane.`,
        );
      else if (link && changed.includes('delegate') && issue.delegateId !== tracker.ownerOf(GITHUB_FEED)) {
        // A person took the ticket back: it carries their hands' label
        // **before** the stop wakes the walk (ruled 2026-10-03), or aivi
        // would re-delegate itself in the same breath the human cleared the
        // field.
        await markForHuman(GITHUB_FEED, issue.id);
        await services.orchestrator.stop(run.id, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
      }
    };

    const onIssue = async (event: Extract<TrackerEvent, { kind: 'updated' }>) => {
      if (!event.changed.length) return;
      let issue: TrackerIssue;
      try {
        issue = await tracker.issue(GITHUB_FEED, event.issueId);
      } catch (error) {
        if (!isGoneError(error)) throw error;
        // A `deleted` delivery and a ticket that answers nothing are the
        // same fact: whatever still works it stops.
        const run = services.orchestrator.activeRun(MODULE_ID, event.issueId);
        if (run) await services.orchestrator.stop(run.id, `Stopped: ${event.issueId} was deleted; there is no work.`);
        for (const conversation of store.pendingForIssue(event.issueId))
          await stopAssistant(conversation, `Stopped: ${event.issueId} was deleted; there is no work to do.`);
        return;
      }
      const routed = projectForIssue(services.loaded, { repo: issue.teamId });
      if (!routed) return;
      const lane = laneOf(routed.project, issue.state.name);
      const human = issue.labels.some(l => l.name === config.humanLabel);
      // A hand-set `Agent` value with no run working the ticket: the fixed
      // refusal (work reaches me through the board). Our own `initWork`
      // value finds its live run and passes; an ending's clearing names
      // nobody and passes.
      if (
        event.changed.includes('delegate') &&
        issue.delegateId === tracker.ownerOf(GITHUB_FEED) &&
        !services.orchestrator.activeRun(MODULE_ID, issue.id)
      ) {
        await unclaimed(
          issue,
          'work reaches me through the board, not through the `Agent` field: I start a worker myself once the ticket sits in a lane I work.',
        );
        return;
      }
      await stopOrphanRun(issue, lane, human, event.changed);
      const pending = store.pendingForIssue(issue.id);
      await stopOrphans(pending, issue, lane, human, event.changed);
      // Anything a person does to a ticket's place or standing wakes the
      // walk — **unless the ticket sits where aivi does not look**: a human
      // lane that is not the queue, or a Status option not in the array at
      // all. Out of sight, out of mind — the event is ignored, not failed.
      // A run the move stranded was already stopped above, and a stop wakes
      // the walk itself.
      if (event.changed.includes('state') || event.changed.includes('labels')) {
        services.orchestrator.cancelWaiting(MODULE_ID, issue.id); // a person's move cancels a waiting request
        if (lane === undefined || (lane.agent === undefined && !lane.queue)) return;
        void services.orchestrator.wake(routed.project.id); // a lane move is a wake and nothing more
      }
    };

    /** Everything downstream keys off the adapter's normalized events — the
     *  endpoint, the signature and the acknowledgement are the adapter's.
     *  A handler that throws is logged and dropped: the delivery was
     *  acknowledged already, so a retry would only replay what failed. */
    const unsubscribeEvents = tracker.events(async event => {
      try {
        if (abort.signal.aborted) return;
        if (event.kind === 'started') await onBrought(event.conversation, event.issueId, event.promptContext);
        else if (event.kind === 'prompted') await onPrompted(event);
        else await onIssue(event);
      } catch (error) {
        log.warn('event.failed', { error });
      }
    });
    const unregisterRoute = registerWebhookRoute(services.routes, tracker, log);

    // An assistant turn interrupted by a restart is blocked (nobody knows whether the agent stopped); say so on its ticket.
    for (const turn of interrupted)
      await say(
        turn.channel,
        'aivi was restarted while I was working. The OpenCode session is left as it is; an operator must inspect and resolve this before the project is worked on again.',
        'outcome',
      );

    // Our boot pass, ours alone: every pair whose closing has **not landed**
    // and whose run has ended owes GitHub its closing — the final comment
    // may have died in an outage. Each step asks GitHub's real state first,
    // so a catch-up that already happened says nothing twice, and a pair
    // whose closing landed is settled — never asked again. The lane moves
    // are the orchestrator's own debt and its boot pass re-drives them.
    for (const link of links.owed()) {
      const run = services.orchestrator.runBySession(link.opencodeSession!);
      if (run && isTerminal(run.state)) {
        closings.set(run.id, run);
        await driveClosing(run.id).catch(() => {});
      }
    }

    const unregister = services.channels.register({
      id: GITHUB.id,
      accepts: () => false,
      ownsSession: session => store.channelOf(session) !== null,
      channelOf: async () => undefined,
      async reenter(session, text, context) {
        store.enqueueJobResult(context.run.id, session, text, 100);
        engine?.tick();
      },
      async post() {
        throw new Error('GitHub is not a report destination; report to a chat channel instead');
      },
    });
    const unsubscribeWake = services.onWake(() => {
      engine!.tick();
      void retryClosings();
    });
    engine.tick();
    log.info('ready', { org: client.org, app: client.delegateName });

    return {
      async stop() {
        unsubscribeEvents();
        unregisterRoute();
        unregister();
        unsubscribeWake();
        await teardown();
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** For `aivi github status`: what each assistant conversation is doing.
 *  Workers live in the orchestrator's ledger now; their lines join this view
 *  when the status command is formalized with the extraction. */
export function describeWorkers(
  store: ConversationStore,
): { conversation: string; agent: string | null; issue: string | null; turn: Turn }[] {
  return store
    .list()
    .filter(t => !['sent', 'discarded'].includes(t.state))
    .map(t => {
      const binding = store.sessionOf(t.channel);
      return {
        conversation: t.channel,
        agent: binding?.agent ?? null,
        issue: binding?.issue ?? null,
        turn: t,
      };
    });
}
