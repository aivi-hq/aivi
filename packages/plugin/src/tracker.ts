/**
 * The **tracker** contract: the seam between aivi and a ticket system.
 * A tracker owns tickets — lanes, delegation, what people write on them.
 * An adapter is a translator in both directions and nothing else: it turns
 * the platform's events into the neutral ones below and aivi's neutral
 * updates into the platform's mutations. Lane matching, guards, capacity,
 * worktrees and the exit contract are aivi's machinery, never the
 * adapter's, and they spell `tracker` — never `linear` or any other name.
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
  /** The states of the tickets blocking this one, in the platform's own
   *  words; the platform answers which of them are finished. */
  blockedByStates: string[];
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
export interface Tracker {
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
  /** Subscribe to the normalized events. The adapter owns the platform's
   *  whole inbound surface — endpoints, signatures, acknowledgements;
   *  registration happens at module start. Returns the unsubscribe. */
  events(sink: (event: TrackerEvent) => Promise<void>): () => void;
}
