/**
 * The **tracker** contract, in the two seams a tracker module lives between.
 *
 * `Tracker` is the seam between the host's orchestrator and the module: the
 * **stages** a run is walked through, keyed by the run. The orchestrator
 * walks them in order and awaits only the lifecycle ones; it never learns
 * what a ticket platform is. `Platform` is the seam between the module and
 * its ticket platform: the conversation-keyed translator that turns the
 * platform's events into neutral ones and aivi's neutral updates into the
 * platform's mutations. A module registers one `Tracker` with the
 * orchestrator and speaks its `Platform` to whomever on its platform; the
 * stages that render are usually one-line forwards — the division is honest,
 * not duplicated.
 *
 * The words here are platform-neutral by design: roughly seven trackers will
 * move this contract, and every entry earns its place with a second
 * tracker's need. The run shapes the stages carry are the shared run domain
 * (`./run.ts`); the ticket shapes here are what the tracker reports and the
 * orchestrator routes.
 */

import type { RunPlan, RunQuestion, RunView } from './run.ts';

/**
 * The work a tracker answers for: the **stages** the orchestrator walks a
 * run through, and the board it walks for work. Division of labour, said as
 * an interface: the orchestrator orchestrates and never learns what a ticket
 * platform is; the tracker tracks and answers for its platform alone. A
 * tracker module registers ONE of these at start; the orchestrator calls the
 * stages in the documented order and awaits only the lifecycle ones
 * (`initWork`, `endWork`): their failure is the run's failure, said visibly.
 * The renders (`ready`, `startWork`, `question`, `plan`) are fire-and-forget
 * — a platform that cannot show a thing loses nothing the orchestrator cares
 * about, and a tracker retries its own renders in its own time. The order is
 * owned by `docs/orchestrator.md` ("The tracker's stages").
 *
 * `initWork` is where a tracker does whatever its platform needs to open a
 * ticket to work — Linear delegates the issue to its own app and Linear's
 * answer carries the new agent session — and it hands back the ticket's
 * **summary**: the words the worker is started with, composed around the
 * directory and the lane by the orchestrator, which never reads a ticket
 * itself. A tracker that needs nothing answers with the ticket's text alone.
 */
/** What `initWork` answers with: the words the worker is started with, and
 *  the ticket's **branch name** where the platform names one. A lane that
 *  writes (`worktree: true`) gets its worktree on this branch, and the
 *  orchestrator never invents a name — such a lane whose tracker answers
 *  without one fails the run visibly. A tracker whose platform has no
 *  branch answers with the summary alone. */
export interface WorkEntry {
  summary: string;
  branch?: string;
}

export interface Tracker {
  /** The module id this tracker speaks for (`tracker-linear`): the key
   *  the orchestrator records claims and queue places under. */
  readonly id: string;

  /** The projects this tracker speaks for, by core id: what a walk
   *  visits. */
  projects(): string[];
  /** Tickets sitting in a lane, in the board's own top-to-bottom order.
   *  `blocked` says a person's move is awaited, whatever the platform
   *  calls it; blocked tickets wait and are never claimed. */
  tickets(projectId: string, lane: string): Promise<{ id: string; blocked: boolean }[]>;
  /** Move a ticket into a lane: the queue pickup says it before the
   *  worker starts, an ending moves the ticket where the lane order put
   *  it. The orchestrator's decision; the tracker performs it. */
  moveTo(projectId: string, ticketId: string, lane: string): Promise<void>;
  /** Which lane the ticket sits in **right now**, by name; undefined when it
   *  is gone from this board — deleted, or on a team the project does not
   *  map. The orchestrator's validity check before an ending move (ruled
   *  2026-10-02): a person may have moved the ticket out from under a live
   *  run while a webhook was missed; their move wins, and the owed move is
   *  spent rather than undone. */
  ticketLane(projectId: string, ticketId: string): Promise<string | undefined>;

  /** The dispatcher's slot is in hand and the run is claimed: open the
   *  ticket to work on the platform and answer with the **work entry**:
   *  the summary the worker is started with, and the **branch the ticket
   *  works on** when the platform names one (Linear's `Issue.branchName`).
   *  A lane that writes gets its worktree on that branch, and the
   *  orchestrator never invents a name — a worktree lane whose tracker
   *  answers without one fails the run visibly. Linear's delegate
   *  mutation creates the agent session and its answer serves as the
   *  summary; the tracker stores the pair and may already post a first
   *  word ("preparing the workspace"). Failure fails the run — visibly,
   *  and the slot goes back. AWAITED. */
  initWork(run: RunView): Promise<WorkEntry>;
  /** The worker's session exists and its work environment is ready:
   *  where a tracker attaches the run to the pair it opened at
   *  `initWork`. A render. */
  ready(run: RunView): void | Promise<void>;
  /** The task went into the session and work is turning. Optional: a
   *  platform whose session already shows life (Linear watches its own
   *  agent sessions) says nothing here. */
  startWork?(run: RunView): void | Promise<void>;
  /** The worker asked a person a question and parked. **Required of
   *  every tracker**: the OpenCode form is the durable record of the
   *  wait, but only the tracker knows what a question looks like on its
   *  platform. A render. */
  question(run: RunView, question: RunQuestion): void | Promise<void>;
  /** The worker's working plan, whole as it stands. Optional: a platform
   *  without a plan surface drops it. A render. */
  plan?(run: RunView, plan: RunPlan): void | Promise<void>;
  /** The run ended: say so where people read — the closing words in the
   *  shape the platform gives endings (Linear responds its agent
   *  session, which ends it). The move to the next lane is the
   *  orchestrator's and happens after this returns; the lease returns
   *  last. A permanent failure here does not hold the ticket: the
   *  ending failed is said and the person is asked for help (a tracker
   *  marks its ticket for a human, in its platform's words), while the
   *  closing stays owed to the tracker's own retries. AWAITED. */
  endWork(run: RunView): Promise<void>;
}

/** One workflow state of a team, as the platform holds it. `type` is the
 *  platform's own flavor word — Linear's `completed`/`canceled` are finished
 *  work; the machinery asks the adapter what a finished state means and
 *  never compares raw words of one platform. */
export interface TrackerState {
  id: string;
  name: string;
  type: string;
}

/** A ticket, in the neutral shape the machinery reads. Every field exists
 *  because the routing decisions read it; `state` is the ticket's current
 *  lane, `teamId` is what routes a ticket to a project. */
export interface TrackerIssue {
  id: string;
  /** The human-facing id (`ENG-1`): what people read and comments quote. */
  identifier: string;
  title: string;
  description: string | null;
  /** The branch the platform suggests for this ticket; empty when it has no opinion. */
  branchName: string;
  url: string;
  state: TrackerState;
  teamId: string;
  labels: { id: string; name: string }[];
  /** Whose user id the ticket is delegated to; null when nobody's. */
  delegateId: string | null;
  assignee: { id: string; name: string } | null;
  /** True once the platform has deleted the ticket as far as work goes;
   *  a dead ticket gets nothing from aivi. */
  archived: boolean;
  /** Whether the ticket has finished as far as work goes — the adapter's
   *  **verdict**, not a platform word: each tracker decides which of its
   *  states mean closed (Linear's `completed` and `canceled` both do), and the
   *  decision code never sees the words. */
  completed: boolean;
  /** The tickets blocking this one, each with the same verdict: a blocker
   *  that has finished holds nothing back. */
  blockedBy: { id: string; completed: boolean }[];
}

/** What changed on a ticket, in neutral words: only the things routing
 *  keys on. `archive` is the platform's word for *deleted* — the ticket is
 *  gone as work, which stops whatever still works it. Anything else a
 *  platform reports is the adapter's to notice and drop. */
export type TrackerChange = 'state' | 'labels' | 'delegate' | 'archive';

/**
 * The normalized signals everything downstream keys off — never raw
 * webhooks. `started` is a working session opened on a ticket (a
 * delegation, a mention, whatever brought it); `prompted` is a message
 * inside one, or a signal like a stop; `updated` is a ticket change with
 * `changed` already narrowed to the routing-relevant parts.
 */
export type TrackerEvent =
  | { kind: 'started'; conversation: string; issueId: string; promptContext?: string }
  | { kind: 'prompted'; id: string; conversation: string; body?: string; signal?: string | null }
  | { kind: 'updated'; conversation: string; issueId: string; changed: TrackerChange[] };

/** How a message reads, in platform-neutral words; the adapter picks the
 *  platform's own rendering (Linear maps these to agent-session activity
 *  types). Adapters keep the distinction honest: a `progress` line is gone
 *  when the work ends, an `answer` or `outcome` stays. */
export type TrackerCommentKind =
  /** A reply to what someone asked — the platform shows it as an answer. */
  | 'answer'
  /** An ephemeral line while work runs; replaced as work moves. */
  | 'progress'
  /** A durable line about work in flight. */
  | 'note'
  /** A terminal outcome: finished, stopped, or refused. */
  | 'outcome';

/** What the machinery asks of the platform, in neutral words. The adapter
 *  translates and performs; *when* to act stays the machinery's decision. */
export type TrackerUpdate =
  /** Move the ticket to the named lane. */
  | { kind: 'move'; lane: string }
  /** Add or remove one label. */
  | { kind: 'label'; label: string; on: boolean }
  /** Leave a visible comment on the ticket itself. */
  | { kind: 'comment'; text: string };

/** One moment of a worker's progress, in neutral words: the human-readable
 *  status line as already rendered, and the tool the worker is running when
 *  there is one. Rendered by the machinery (the same reducer a chat progress
 *  placeholder reads), delivered the platform's way. */
export interface TrackerProgressLine {
  /** The status as text: "🔧 reading src/x.ts", "⏳ thinking…". */
  text: string;
  /** The running tool, when there is one and the platform shows tools. */
  tool?: { name: string; detail?: string };
}

/**
 * The tracker's **platform**: the ticket system behind a tracker module —
 * Linear, Jira, GitHub Issues — seen as the conversation-keyed translator it
 * is. A tracker owns tickets — lanes, delegation, what people write on them;
 * the platform speaks its platform's voice: it turns the platform's events
 * into the neutral ones above, aivi's neutral updates into the platform's
 * mutations, and it is **required** to render a worker's question and a run's
 * outcome the way its platform shows them (`ask`, and the answer/outcome
 * kinds of `comment`) — the host's orchestrator owns the run itself: its
 * durable record, its session, the two worker tools and the rule that only a
 * tool call ends it. Channels use platforms, forges use platforms, and this
 * is the same word for the same thing: the system aivi talks to over an API.
 *
 * The machinery consuming this ships in the host. The exact member set is
 * **provisional by design**: roughly seven trackers will move it, and every
 * entry earns its place with a second tracker's need.
 */
export interface Platform {
  /** The module id this tracker speaks for (`tracker-linear`). */
  readonly id: string;
  /** The team's workflow states as the platform holds them, so a proposed
   *  lane mapping can be validated against what exists. */
  laneStates(conversation: string, teamId: string): Promise<TrackerState[]>;
  /** Create the named states the mapping needs and none platform policy
   *  refuses, returning the ones made. Opt-in with an explicit yes per
   *  team, never silent. Absent means the tracker cannot create states. */
  createStates?(conversation: string, teamId: string, missing: string[]): Promise<TrackerState[]>;
  /** Ready issues in a lane, in the platform's own order, each with the
   *  facts needed to build a worker's first message. Absent until a
   *  pull-shaped tracker needs it. */
  candidates?(conversation: string, lane: string): Promise<TrackerIssue[]>;
  /** Apply one neutral outcome to a ticket. Absent while the machinery
   *  still writes its updates through the members below. */
  apply?(conversation: string, issueId: string, update: TrackerUpdate): Promise<void>;
  /** The ticket, fresh from the platform — the only routing input, never
   *  trusted from an event's own words. Delivered in the neutral shape;
   *  the adapter's translation is where platform fields stop existing. */
  issue(conversation: string, issueId: string): Promise<TrackerIssue>;
  /** Make (with `null`: unmake) aivi the ticket's delegate — the neutral
   *  word for whoever the platform names to work it. */
  assign(conversation: string, issueId: string, userId: string): Promise<void>;
  unassign(conversation: string, issueId: string): Promise<void>;
  /** Open a working session on the ticket under aivi's own identity,
   *  returning its conversation id; null when the platform made none.
   *  Some platforms create the session as a side effect of `assign`;
   *  hiding that is exactly the adapter's job. */
  startSession(conversation: string, issueId: string): Promise<string | null>;
  /** The conversation id for a session the platform names, in the
   *  adapter's namespacing; what the store binds. */
  idFor(sessionId: string): string;
  /** The other direction, for what is named *from* a conversation: the
   *  configured app within aivi that speaks it, and the platform's own
   *  session id inside it (a worker's worktree is named from that). The
   *  conversation string itself is the adapter's business, never parsed
   *  by the machinery. */
  parts(conversation: string): { app: string; session: string };
  /** The workspace (organization) the conversation's app speaks in; what
   *  routes a ticket to a project besides the team. */
  orgOf(conversation: string): Promise<string>;
  /** Whose user id aivi is in the conversation's workspace — the delegate
   *  id `assign` and `startSession` use, and what a "delegate changed"
   *  check compares against. */
  ownerOf(conversation: string): string;
  /** One message into the conversation, rendered the platform's way; the
   *  platform's message id when it names them (the engine may edit by it). */
  comment(conversation: string, text: string, kind: TrackerCommentKind): Promise<string | undefined>;
  /**
   * Show what a worker is doing **right now**, replacing whatever was shown
   * before (ruled 2026-10-02: thoughts and actions, ephemeral — a working
   * run says what it does without ever spamming the ticket). **Transient by
   *  contract**: a replaced line must not linger as a permanent record.
   *  Linear posts an ephemeral `action` activity when a tool runs and an
   *  ephemeral `thought` otherwise. Absent means the platform has no
   *  progress surface and hears nothing: a worker there works in silence,
   *  and the follower never calls it.
   */
  progress?(conversation: string, line: TrackerProgressLine): Promise<void>;
  /**
   * A plain notice on the ticket **itself**, for a run that died before it
   * had a conversation to speak through (ruled 2026-10-02 after seven silent
   * early failures): silence is not an answer, and the ticket is the only
   * board a person reads. The `conversation` is the app's own feed — there
   * is no session yet.
   */
  notify(conversation: string, issueId: string, text: string): Promise<void>;
  /** Whether this working session has already had its result rendered —
   *  the follower's idempotence question, decided the platform's own way
   *  (Linear: the agent session is ended; another: a result comment exists).
   *  A catch-up that would say it twice says it once. */
  resultShown(conversation: string): Promise<boolean>;
  /** A closing note on the **ticket itself**, so an ending is readable
   *  without opening the agent session (ruled 2026-10-02: the answer was
   *  only visible inside the session — "hard to get to now"). Optional: a
   *  platform with nothing standing outside the session posts no extra note
   *  and loses nothing. **Idempotence is the adapter's** — the follower
   *  retries this on every wake and boot like the rest of the ceremony, so
   *  a note already standing must never be posted twice. */
  closingNote?(conversation: string, issueId: string, text: string): Promise<void>;
  /**
   * Put a worker's question to the people, in the platform's own shape —
   * the same `RunQuestion` the orchestrator recorded, rendered here.
   * **Required of every tracker** (ruled 2026-09-30): the orchestrator
   * records the question and does nothing else with it — only the adapter
   * knows what a question looks like on its platform (Linear renders an
   * elicitation activity, with its `select` signal when there are options;
   * GitHub Issues would post a numbered comment). The answer arrives as an
   * ordinary message event; the open OpenCode form is the discriminator,
   * read from OpenCode, never a guess from texts.
   */
  ask(conversation: string, question: RunQuestion): Promise<void>;
  /**
   * Show the worker's working plan — the whole checklist, as it now stands.
   * A forwarding like the orchestrator's own: the tracker renders it in its
   * platform's shape (Linear replaces the session's agent plan wholesale)
   * and nothing about a run waits on its delivery.
   */
  plan(conversation: string, plan: RunPlan): Promise<void>;
  /** Subscribe to the normalized events. The adapter owns the platform's
   *  whole inbound surface — endpoints, signatures, acknowledgements;
   *  registration happens at module start. Returns the unsubscribe. */
  events(sink: (event: TrackerEvent) => Promise<void>): () => void;
}
