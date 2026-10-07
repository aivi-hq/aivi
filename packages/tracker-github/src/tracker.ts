/** GitHub's **platform**: the `Platform` contract of `@aivi/plugin/tracker`
 *  spelled in GitHub's words. It owns everything GitHub-shaped below the
 *  neutral surface — the one app and its credential (through `@aivi/github`),
 *  the webhook route and its seal, the board reads and the `Agent` field, the
 *  status comment and its hidden state (D6, D7) — and translates at the
 *  border: deliveries become `TrackerEvent`s, neutral updates become GitHub
 *  mutations. The module's decision code imports **no** GitHub types through
 *  this file.
 *
 *  **Conversations** are the adapter's own affair, and GitHub's are the
 *  ticket and its status comment (no agent session exists for an app — D5):
 *
 *  - `github` — the app's own feed: desk calls and notices, no session.
 *  - `github:owner/repo#47` — a person brought the ticket: the **assistant's**
 *    conversation, the ticket itself.
 *  - `github:owner/repo#47:c123` — a **run's** conversation: the status
 *    comment `startSession` created (D6). Its body carries the machine state
 *    as a hidden JSON comment (D7); visible words, plan checklist, and the
 *    hidden line are all one edited comment.
 */
import { getLogger, type LoadedConfig, type Logger } from '@aivi/core';
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@aivi/github';
import type { PublicRequest, PublicRoutes } from '@aivi/plugin';
import type { RunPlan, RunQuestion } from '@aivi/plugin/run';
import type {
  Platform,
  TrackerChange,
  TrackerComment,
  TrackerCommentKind,
  TrackerEvent,
  TrackerIssue,
  TrackerProgressLine,
  TrackerState,
  TrackerUpdate,
} from '@aivi/plugin/tracker';
import type { GithubClient, GithubIssue } from './client.ts';
import { isGoneError } from './client.ts';
import type { ProjectGithub } from './config.ts';
import { MODULE_ID } from './config.ts';
import { projectForIssue, projectGithub } from './projects.ts';
import {
  DeliveryLedger,
  editedFieldName,
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
  type IssueCommentPayload,
  type IssuesPayload,
  isBotAuthor,
  type ProjectsV2ItemPayload,
} from './webhook.ts';

/** The app's own feed: desk calls and notices speak here — there is no
 *  session to name, and one app speaks for the home. */
export const GITHUB_FEED = 'github';

/** A run conversation's session id: the ticket with its status comment's id
 *  on it — `owner/repo#47:c123`. */
const RUN_SESSION = /^(.+#\d+):c(\d+)$/;
/** A bare ticket ref as a conversation names it: `owner/repo#47`. */
const TICKET_SESSION = /^([^/]+\/[^#]+)#(\d+)$/;

/** The hidden machine-state line (D7): JSON in an HTML comment at the body's
 *  end. GitHub shows a person the words and hands aivi the state. */
const META_LINE = /<!--\s*(\{[\s\S]*\})\s*-->\s*$/;

export interface StatusBody {
  head: string;
  planLines: string[];
  meta: Record<string, unknown>;
}

/** Read a status comment's body into its parts. A body with no hidden line
 *  (a person edited it away) still reads: the state defaults to a standing
 *  status, and the words are whatever stands. */
export function parseStatus(body: string): StatusBody {
  const found = META_LINE.exec(body);
  let meta: Record<string, unknown> = { kind: 'status' };
  let rest = body;
  if (found) {
    try {
      meta = JSON.parse(found[1]!) as Record<string, unknown>;
    } catch {
      /* a person broke the JSON: the state is unreadable, the status stands */
    }
    rest = body.slice(0, found.index).trimEnd();
  }
  const lines = rest.split('\n');
  const head = lines.shift() ?? '';
  const planLines: string[] = [];
  const at = lines.indexOf('### Plan');
  if (at >= 0) for (const line of lines.slice(at + 1)) if (line.startsWith('- ')) planLines.push(line);
  return { head, planLines, meta };
}

/** The whole body from its parts: head line, plan section when there is
 *  one, and the hidden line last. */
export function renderStatus(head: string, planLines: string[], meta: Record<string, unknown>): string {
  const parts = [head];
  if (planLines.length) parts.push(['### Plan', ...planLines].join('\n'));
  parts.push(`<!-- ${JSON.stringify(meta)} -->`);
  return `${parts.join('\n\n')}\n`;
}

const planStepLine = (step: { content: string; status: string }): string =>
  step.status === 'completed'
    ? `- [x] ${step.content}`
    : step.status === 'canceled'
      ? `- [-] ${step.content}`
      : `- [ ] ${step.content}`;

/** The error a read answers when the surface it read is gone: shaped so
 *  `isGoneError` says gone, because the closer's drop-the-debt path keys on
 *  it exactly as Linear's does on `Entity not found`. */
const gone = (what: string): Error => {
  const error = new Error(`${what} is gone (deleted, or never visible to the app)`);
  (error as { status?: number }).status = 404;
  return error;
};

export class GithubPlatform implements Platform {
  readonly id = MODULE_ID;
  private readonly loaded: LoadedConfig;
  readonly client: GithubClient;
  private readonly webhookSecret: string;
  private readonly log: Logger;
  private readonly deliveries = new DeliveryLedger();
  private readonly sinks = new Set<(event: TrackerEvent) => Promise<void>>();
  /** Which board node ids aivi speaks, by board number — warmed at start.
   *  A `projects_v2_item` delivery names its board by node id and nothing
   *  else; a board nobody configured is noise and says nothing. */
  private readonly boardNodes = new Map<string, number>();

  constructor(
    loaded: LoadedConfig,
    client: GithubClient,
    webhookSecret: string,
    log: Logger = getLogger(['aivi', MODULE_ID]),
  ) {
    this.loaded = loaded;
    this.client = client;
    this.webhookSecret = webhookSecret;
    this.log = log;
  }

  /** Resolve every configured board's fields once, at module start: it says
   *  of a missing `Status` or `Agent` field before any walk asks, and it
   *  teaches the delivery filter which boards are ours. */
  async warm(): Promise<void> {
    for (const project of this.loaded.projects) {
      if (project.removed) continue;
      const github = projectGithub(this.loaded, project.id);
      if (!github) continue;
      const fields = await this.client.boardFields(github.board);
      this.boardNodes.set(fields.projectId, github.board);
    }
  }

  // ——— board lookups ———

  /** Which board speaks for a repository's issues, and for a ticket by way
   *  of its repository. */
  private boardOfRepo(repo: string): ProjectGithub | undefined {
    return projectForIssue(this.loaded, { repo: repo })?.github;
  }

  private boardOf(issueId: string): ProjectGithub {
    const repo = issueId.slice(0, issueId.indexOf('#'));
    const github = this.boardOfRepo(repo);
    if (!github) throw new Error(`${issueId} feeds no aivi project: ${repo} is in no project's repos`);
    return github;
  }

  // ——— the neutral surface ———

  async laneStates(_conversation: string, teamId: string): Promise<TrackerState[]> {
    const github = this.boardOfRepo(teamId);
    if (!github) throw new Error(`${teamId} feeds no aivi project: it has no board and no states`);
    return (await this.client.laneOptions(github.board)).map(o => ({ id: o.id, name: o.name, type: '' }));
  }

  /** `createStates` is deliberately absent (D4): lanes map onto the board's
   *  own Status options, and aivi never creates or renames one — the human's
   *  board is not aivi's to edit. */

  async apply(_conversation: string, issueId: string, update: TrackerUpdate): Promise<void> {
    if (update.kind === 'move') {
      await this.client.setLane(issueId, this.boardOf(issueId).board, update.lane);
      return;
    }
    if (update.kind === 'label') {
      if (update.on) await this.client.addLabel(issueId, update.label);
      else await this.client.removeLabel(issueId, update.label);
      return;
    }
    await this.client.createComment(issueId, update.text);
  }

  async issue(_conversation: string, issueId: string): Promise<TrackerIssue> {
    return this.neutralIssue(await this.client.issue(issueId));
  }

  async assign(_conversation: string, issueId: string, userId: string): Promise<void> {
    await this.client.setAgent(issueId, this.boardOf(issueId).board, userId);
  }

  async unassign(_conversation: string, issueId: string): Promise<void> {
    await this.client.setAgent(issueId, this.boardOf(issueId).board, null);
  }

  /** Open the run's conversation (D6): one status comment, the first word
   *  visible and the machine state hidden under it. Its id, with the ticket
   *  on it, is the conversation handle the module records. */
  async startSession(_conversation: string, issueId: string): Promise<string | null> {
    const made = await this.client.createComment(
      issueId,
      renderStatus('**Preparing the workspace…**', [], { kind: 'status' }),
    );
    return `${issueId}:c${made.id}`;
  }

  idFor(sessionId: string): string {
    return `${GITHUB_FEED}:${sessionId}`;
  }

  parts(conversation: string): { app: string; session: string } {
    if (conversation === GITHUB_FEED) return { app: GITHUB_FEED, session: '' };
    const session = conversation.startsWith(`${GITHUB_FEED}:`)
      ? conversation.slice(GITHUB_FEED.length + 1)
      : conversation;
    return { app: GITHUB_FEED, session };
  }

  async orgOf(_conversation: string): Promise<string> {
    return this.client.org;
  }

  /** Who aivi is on a ticket: the `Agent` field's option named for the app
   *  (D5) — the same word on every board; per-board option ids are the
   *  client's resolution detail. */
  ownerOf(_conversation: string): string {
    return this.client.delegateName;
  }

  /** One message into a conversation, and the conversation decides what a
   *  transient word **is**: inside a run it edits the status comment (no
   *  second comment may linger — transient by contract); on a ticket it is
   *  the assistant's placeholder, a real comment the engine may edit by id
   *  and delete when the answer lands. */
  async comment(conversation: string, text: string, kind: TrackerCommentKind): Promise<string | undefined> {
    const session = this.parts(conversation).session;
    const run = RUN_SESSION.exec(session);
    if (run) {
      if (kind === 'progress') {
        await this.progress(conversation, { text });
        return undefined;
      }
      const made = await this.client.createComment(run[1]!, text);
      return String(made.id);
    }
    if (!TICKET_SESSION.test(session)) throw new Error(`${conversation} is not a conversation a comment lands on`);
    const made = await this.client.createComment(session, text);
    return String(made.id);
  }

  /** Replace the status comment's line — the only edit a progress word may
   *  make. A frozen comment (the closing landed) is left as it stands: the
   *  closing is the last word, and a trailing in-flight edit never speaks
   *  after it. */
  async progress(conversation: string, line: TrackerProgressLine): Promise<void> {
    const { ref, commentId } = this.runOf(conversation);
    const body = await this.client.getComment(ref, commentId);
    if (body === undefined) throw gone(`the status comment of ${ref}`);
    const standing = parseStatus(body);
    if (standing.meta.kind === 'done') return;
    const tool = line.tool ? ` · \`${line.tool.name}${line.tool.detail ? ` ${line.tool.detail}` : ''}\`` : '';
    await this.client.updateComment(
      ref,
      commentId,
      renderStatus(`**${line.text}**${tool}`, standing.planLines, standing.meta),
    );
  }

  /** A run that died before it had a conversation still speaks on the
   *  ticket: silence is not an answer (ruled 2026-10-02). */
  async notify(_conversation: string, issueId: string, text: string): Promise<void> {
    await this.client.createComment(issueId, text);
  }

  /** Has this run's result been rendered? GitHub keeps no session to ask:
   *  the answer is a comment on the ticket whose hidden line says
   *  `kind: closing` **and names this run's status comment** — so a catch-up
   *  says each run's result once, and a second run on the same ticket is a
   *  different conversation with its own result. */
  async resultShown(conversation: string): Promise<boolean> {
    const { ref, commentId } = this.runOf(conversation);
    for (const comment of await this.client.comments(ref)) {
      if (!isBotAuthor({ type: comment.authorIsBot ? 'Bot' : 'User' })) continue;
      const meta = parseStatus(comment.body).meta;
      if (meta.kind === 'closing' && Number(meta.status) === commentId) return true;
    }
    return false;
  }

  /** Put the worker's question to the people (required of every tracker):
   *  GitHub Issues renders a numbered comment; the answer arrives as an
   *  ordinary comment and the open OpenCode form tells it from chatter. */
  async ask(conversation: string, question: RunQuestion): Promise<void> {
    const { ref } = this.runOf(conversation);
    const lines = [`**Question** · ${question.question}`];
    if (question.options?.length)
      lines.push(
        question.options
          .map((o, i) => `${i + 1}. ${o.label}${o.value === o.label ? '' : ` — \`${o.value}\``}`)
          .join('\n'),
      );
    await this.client.createComment(ref, renderStatus(lines.join('\n\n'), [], { kind: 'question' }));
  }

  /** Show the worker's plan: the whole checklist, replacing what stood, in
   *  the status comment's own plan section. */
  async plan(conversation: string, plan: RunPlan): Promise<void> {
    const { ref, commentId } = this.runOf(conversation);
    const body = await this.client.getComment(ref, commentId);
    if (body === undefined) throw gone(`the status comment of ${ref}`);
    const standing = parseStatus(body);
    await this.client.updateComment(
      ref,
      commentId,
      renderStatus(standing.head, plan.steps.map(planStepLine), standing.meta),
    );
  }

  // ——— the ticket desk (the app's own feed; conversation selects nothing) ———

  async ticketComments(_conversation: string, issueId: string): Promise<TrackerComment[]> {
    return this.client.comments(issueId);
  }

  async addComment(_conversation: string, issueId: string, text: string): Promise<void> {
    await this.client.createComment(issueId, text);
  }

  async editIssue(
    _conversation: string,
    issueId: string,
    changes: { title?: string; description?: string },
  ): Promise<TrackerIssue> {
    return this.neutralIssue(await this.client.updateIssue(issueId, changes));
  }

  async createIssue(
    _conversation: string,
    input: { teamId: string; title: string; description?: string; lane?: string },
  ): Promise<TrackerIssue> {
    const { lane, ...words } = input;
    const made = await this.client.createIssue(input.teamId, {
      title: words.title,
      ...(words.description !== undefined ? { body: words.description } : {}),
    });
    if (lane) {
      const board = this.boardOfRepo(input.teamId)?.board;
      if (board === undefined) throw new Error(`${input.teamId} feeds no aivi project: ${lane} is nowhere to land it`);
      const options = await this.client.laneOptions(board);
      if (!options.some(o => o.name === lane))
        throw new Error(
          `board ${board} of ${this.client.org} has no Status option "${lane}": it exists on the board or aivi will not guess past it`,
        );
      await this.client.setLane(made.ref, board, lane);
    }
    return this.neutralIssue(made);
  }

  async teamLabels(_conversation: string, teamId: string): Promise<string[]> {
    return this.client.repoLabels(teamId);
  }

  events(sink: (event: TrackerEvent) => Promise<void>): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  // ——— the closing's own words (the module's, not the contract's) ———

  /** The run's final word: a comment of its own, tied to its status comment
   *  so `resultShown` can swear each run said its result once. */
  async markClosing(conversation: string, text: string, success: boolean): Promise<void> {
    const { ref, commentId } = this.runOf(conversation);
    await this.client.createComment(ref, renderStatus(text, [], { kind: 'closing', status: commentId, ok: success }));
  }

  /** Freeze the status comment: the working line goes, the terminal word
   *  stands. Idempotent — a retry lands on an already-frozen comment as
   *  nothing. */
  async freezeStatus(conversation: string, head: string): Promise<void> {
    const { ref, commentId } = this.runOf(conversation);
    const body = await this.client.getComment(ref, commentId);
    if (body === undefined) throw gone(`the status comment of ${ref}`);
    const standing = parseStatus(body);
    if (standing.meta.kind === 'done') return;
    await this.client.updateComment(
      ref,
      commentId,
      renderStatus(head, standing.planLines, { ...standing.meta, kind: 'done' }),
    );
  }

  // ——— inbound: the whole delivery surface ———

  /** One delivery, whole: the seal first (bytes, not re-serialized JSON),
   *  the redelivery filter second, then the acknowledgement — GitHub retries
   *  anything but a 200, and a handler that fails later must not invite a
   *  replay of what already ran. */
  async deliver(request: PublicRequest): Promise<{ status: number; body: unknown }> {
    const event = request.headers[GITHUB_EVENT_HEADER];
    const delivery = request.headers[GITHUB_DELIVERY_HEADER];
    const signature = request.headers[WEBHOOK_SIGNATURE_HEADER];
    if (!event) return { status: 400, body: { error: 'missing X-GitHub-Event' } };
    if (!delivery) return { status: 400, body: { error: 'missing X-GitHub-Delivery' } };
    if (!signature || !verifyWebhookSignature(this.webhookSecret, request.body, signature)) {
      this.log.warn('webhook.refused', { delivery, reason: 'signature mismatch' });
      return { status: 401, body: { error: 'signature mismatch' } };
    }
    if (!this.deliveries.fresh(delivery)) return { status: 200, body: { ok: true, duplicate: true } };
    let payload: unknown;
    try {
      payload = JSON.parse(request.body.toString('utf8'));
    } catch {
      return { status: 400, body: { error: 'body is not JSON' } };
    }
    this.dispatch(event, payload).catch(error => {
      this.log.warn('webhook.failed', { delivery, event, error });
    });
    return { status: 200, body: { ok: true } };
  }

  /** Translate one delivery into normalized events — or into nothing.
   *  `ping`, `installation`, board reorderings, bot comments (aivi answering
   *  itself), and every action outside the routing set are noise (live,
   *  2026-10-07). */
  private async dispatch(event: string, payload: unknown): Promise<void> {
    if (event === 'issue_comment') {
      const p = payload as IssueCommentPayload;
      if (p.action !== 'created' || isBotAuthor(p.comment?.user) || p.issue?.number === undefined) return;
      await this.emit({
        kind: 'prompted',
        id: `comment:${p.comment.id}`,
        conversation: this.idFor(`${p.repository.full_name}#${p.issue.number}`),
        ...(p.comment.body === null ? {} : { body: p.comment.body }),
      });
      return;
    }
    if (event === 'issues') {
      const p = payload as IssuesPayload;
      const changed = issueChanges(p.action);
      if (!changed.length) return;
      await this.emit({
        kind: 'updated',
        conversation: GITHUB_FEED,
        issueId: `${p.repository.full_name}#${p.number}`,
        changed,
      });
      return;
    }
    if (event === 'projects_v2_item') {
      const p = payload as ProjectsV2ItemPayload;
      const boardNumber = this.boardNodes.get(p.project_node_id);
      if (boardNumber === undefined) return; // a board aivi does not speak
      let changed: TrackerChange[];
      if (p.action === 'created')
        changed = ['state']; // added to the board: the walk should look
      else if (p.action === 'edited') {
        const field = editedFieldName(p.changes);
        if (field === undefined) return;
        changed = field === 'Status' ? ['state'] : field === 'Agent' ? ['delegate'] : [];
      } else return; // reordered, archived, moved: noise or nothing routing keys on
      if (!changed.length) return;
      const nodeId = p.projects_v2_item?.content?.node_id;
      if (!nodeId) return;
      const ref = await this.client.nodeRef(nodeId);
      if (!ref) return; // a draft or a pull request: not a ticket
      await this.emit({ kind: 'updated', conversation: GITHUB_FEED, issueId: ref, changed });
      return;
    }
    // ping, installation, repository events and everything else: nothing.
  }

  private async emit(event: TrackerEvent): Promise<void> {
    for (const sink of this.sinks) await sink(event);
  }

  // ——— mapping ———

  /** A GitHub issue in neutral words. The lane is the ticket's Status on the
   *  board its repository feeds; a repository outside every project has no
   *  lane and no delegate, and routing says so rather than inventing one. */
  private neutralIssue(issue: GithubIssue): TrackerIssue {
    const board = this.boardOfRepo(issue.repo)?.board;
    const lane = board === undefined ? undefined : this.client.laneOf(issue, board);
    const agent = board === undefined ? undefined : this.client.agentOn(issue, board);
    return {
      id: issue.ref,
      identifier: issue.ref,
      title: issue.title,
      description: issue.body,
      // GitHub names no branch for a ticket; the tracker generates one (D8).
      branchName: '',
      url: issue.url,
      state: { id: lane?.optionId ?? '', name: lane?.name ?? '', type: '' },
      teamId: issue.repo,
      labels: issue.labels,
      delegateId: agent ?? null,
      assignee: issue.assignees[0] ? { id: issue.assignees[0]!.id, name: issue.assignees[0]!.name } : null,
      // GitHub never deletes an issue; a `deleted` delivery says so by the
      // ticket answering nothing, and that is `gone`'s path.
      archived: false,
      completed: issue.state === 'closed',
      blockedBy: issue.blockedBy,
    };
  }

  /** The ticket and status-comment id behind a run conversation, or the
   *  plain error that this conversation is not one. */
  runOf(conversation: string): { ref: string; commentId: number } {
    const session = this.parts(conversation).session;
    const found = RUN_SESSION.exec(session);
    if (!found) throw new Error(`${conversation} is not a run conversation (github:<owner>/<repo>#<n>:<comment id>)`);
    return { ref: found[1]!, commentId: Number(found[2]) };
  }

  /** A ticket conversation's ref, if the conversation is one. */
  ticketOf(conversation: string): string | undefined {
    const session = this.parts(conversation).session;
    return TICKET_SESSION.test(session) ? session : undefined;
  }
}

/** The neutral changes an `issues` action carries, or none. `assigned` and
 *  `unassigned` are **assignees** — a person's word on GitHub, not the
 *  delegate, which lives in the board's `Agent` field (D5). */
export function issueChanges(action: string): TrackerChange[] {
  if (action === 'labeled' || action === 'unlabeled') return ['labels'];
  if (action === 'closed' || action === 'reopened') return ['state'];
  if (action === 'deleted') return ['archive'];
  return [];
}

/** The public route GitHub is pointed at — no `/app` tail: the seal and the
 *  one app make a second path meaningless. */
export const GITHUB_WEBHOOK_PATH = '/github/webhooks';

/** Own the route; the platform owns the seal, the dedupe and the words.
 *  Failures after the acknowledgement never ride the status: a retry would
 *  only replay what already ran. */
export function registerWebhookRoute(
  routes: PublicRoutes,
  platform: GithubPlatform,
  log: Logger = getLogger(['aivi', MODULE_ID]),
): () => void {
  return routes.register(GITHUB_WEBHOOK_PATH, async request => {
    if (request.method !== 'POST') return { status: 405, body: { error: 'Use POST' } };
    return platform.deliver(request);
  });
}
