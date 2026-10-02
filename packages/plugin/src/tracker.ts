/**
 * The **platform adapter** contract: the seam between a tracker module and
 * its ticket platform. A tracker owns tickets — lanes, delegation, what
 * people write on them. The adapter translates in both directions and
 * speaks its platform's voice:
 * it turns the platform's events into the neutral ones below, aivi's neutral
 * updates into the platform's mutations, and it is **required** to render a
 * worker's question and a run's outcome the way its platform shows them
 * (`ask`, and the answer/outcome kinds of `comment`) — the host's orchestrator
 * owns the run itself: its durable record, its session, the two worker tools
 * and the rule that only a tool call ends it. All of that machinery spells
 * `tracker` — never `linear` or any other name.
 *
 * Types only — the machinery consuming them ships in the host. The exact
 * member set is **provisional by design** ([orchestrator.md](../../docs/plans/templates/orchestrator.md)):
 * more trackers will move it, and every entry earns its place with a
 * second tracker's need.
 */

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

/** What changed on a ticket, in neutral words: only the three things
 *  routing keys on. Anything else a platform reports is the adapter's to
 *  notice and drop. */
export type TrackerChange = 'state' | 'labels' | 'delegate';

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

/**
 * A worker's question to a person, in neutral words: the text, and the
 * options when there are clear choices. `label` is what the person sees;
 * `value` is what an answer arrives as (they may also answer in free text —
 * platforms that render options, like Linear's `select` signal, emit the
 * chosen value as an ordinary message).
 */
export interface TrackerQuestion {
  question: string;
  options?: { label: string; value: string }[];
}

/** One step of a worker's plan: what it will do, and where it stands.
 *  The four statuses are the neutral words; a platform with its own
 *  vocabulary (Linear's `inProgress`) maps them in the adapter. */
export interface TrackerPlanStep {
  content: string;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
}

/** What the machinery asks of the platform, in neutral words. The adapter
 *  translates and performs; *when* to act stays the machinery's decision. */
export type TrackerUpdate =
  /** Move the ticket to the named lane. */
  | { kind: 'move'; lane: string }
  /** Add or remove one label. */
  | { kind: 'label'; label: string; on: boolean }
  /** Leave a visible comment on the ticket itself. */
  | { kind: 'comment'; text: string };

/**
 * The tracker's *conversation*: one working session on a ticket — a
 * worker's or the assistant's. The id is the adapter's own string (Linear
 * namespaces its app's agent sessions); the machinery only carries it, and
 * binds it to agents, projects and issues in its own store.
 */
export interface PlatformAdapter {
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
   * Put a worker's question to the people, in the platform's own shape.
   * **Required of every tracker** (ruled 2026-09-30): the orchestrator records
   * the question and does nothing else with it — only the adapter knows what a
   * question looks like on its platform (Linear renders an elicitation activity,
   * with its `select` signal when there are options; GitHub Issues would post a
   * numbered comment). The answer arrives as an ordinary message event; the
   * open OpenCode form is the discriminator, read from OpenCode, never a
   * guess from texts.
   */
  ask(conversation: string, question: TrackerQuestion): Promise<void>;
  /**
   * Show the worker's working plan — the whole checklist, as it now stands.
   * A forwarding like the orchestrator's own: the tracker renders it in its
   * platform's shape (Linear replaces the session's agent plan wholesale)
   * and nothing about a run waits on its delivery.
   */
  plan(conversation: string, steps: TrackerPlanStep[]): Promise<void>;
  /** Subscribe to the normalized events. The adapter owns the platform's
   *  whole inbound surface — endpoints, signatures, acknowledgements;
   *  registration happens at module start. Returns the unsubscribe. */
  events(sink: (event: TrackerEvent) => Promise<void>): () => void;
}
