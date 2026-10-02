/**
 * The **module contract**: what aivi composes and hands a module at start,
 * and what the module may do with it. Declared here because both sides
 * follow it: the host's `runHost` builds the bag and the modules use it; the
 * host's classes are checked against the interfaces below, so the contract
 * and the machinery cannot drift apart silently.
 *
 * What a module receives is enough to serve and nothing to drive: the run
 * vocabulary (`./run.ts`) is read-only from here, the tracker stages
 * (`./tracker.ts`) are what a tracker hands *in*, and the OpenCode client
 * arrives discovered on every call — a restarted service is picked up by the
 * next unit of work without restarting aivi.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  AddJobOptions,
  AuditEntry,
  Config,
  ExecutionContext,
  ExecutionResult,
  Job,
  JobEntry,
  KnowledgeService,
  Lease,
  LoadedConfig,
  Logger,
  Person,
  PersonToken,
  Report,
  RequestLogEntry,
  Run,
  RunFilter,
  RunState,
  Task,
  ToolDescriptor,
} from '@aivi/core';
import type { OpenCode } from '@opencode/client';
import type { Channels } from './channel.ts';
import type { Forges } from './forge.ts';
import type { RunView } from './run.ts';
import type { Tracker } from './tracker.ts';

/** The OpenCode client a module receives from `services.opencode()`: the
 *  SDK's own client, named here because this is where plugins meet it. */
export type OpenCodeClient = ReturnType<typeof OpenCode.make>;

/** What a module hands back at start: the one thing the host may do to it is stop it. */
export interface RunningModule {
  stop(): Promise<void>;
}

/** The module a plugin package builds: an id the operator configured, a start, and optional system jobs. */
export interface AiviModule {
  /** The module id — the package's short name (`channel-discord`), the same
   *  word as `plugins.<id>`. It keys the supervisor, shows as the `/status`
   *  id and owns task claims. Not the channel's platform id: that one is
   *  `discord` and keys the database, and a module that registers a channel
   *  carries both on purpose. */
  id: string;
  start(services: AiviServices): Promise<RunningModule>;
  /**
   * System jobs to seed beside the host's own while this module is composed.
   * They carry `invocation` tasks for operations the module claims in its
   * `start`; when the module leaves the composition, its jobs are removed
   * with it.
   */
  jobs?(config: Config): Job[];
}

/** Everything the host composes and a module may use. */
export interface AiviServices {
  loaded: LoadedConfig;
  store: Store;
  knowledge: KnowledgeService;
  /** Discovers the OpenCode service on every call. Call once per unit of work and hold the client for its duration. */
  opencode: () => Promise<OpenCodeClient>;
  /** The host's one OpenCode event stream, fanned out by session id; channel progress watches turns through it. */
  events: SessionEvents;
  signal: AbortSignal;
  log: Logger;
  /** Chat platform modules register here once; that makes them report destinations and session owners. */
  channels: Channels;
  /** Webhook routes a module exposes on the host listener, outside bearer auth; the platform's signature is the auth. */
  routes: PublicRoutes;
  /** What `kind: 'invocation'` tasks dispatch to: the host claims its own operations here, modules claim theirs. */
  tasks: TaskClaims;
  /** The tool surface the OpenCode plugin registers at load: the host claims its own tools here, modules claim theirs. */
  tools: ToolClaims;
  /** The forge registry: a forge module registers its `Forge` once at start;
   *  the host's machinery asks who owns a project's remote. A project with no
   *  forge is not a failure — the answer is simply nobody. */
  forges: Forges;
  /** Ticket-to-run machinery: a tracker module registers its stages, stops
   *  runs and reads run records here. The orchestrator owns the run's state
   *  machine, the worker session, and the worker tools; it never calls back. */
  orchestrator: Orchestrator;
  /** Tell the scheduler and every channel engine that the queue or capacity changed; dispatch now. */
  wake(): void;
  /** Be told the same; a channel engine ticks on it instead of polling for capacity released elsewhere. */
  onWake(listener: () => void): () => void;
  /** Abort the whole host. Only for failures the module cannot recover from. */
  fail(error: unknown): void;
}

/**
 * The home store as a module meets it: the whole contract of the host's
 * `Store` class, which is checked against this interface. A module gets the
 * open database for its own tables (namespaced migrations), the job and run
 * surface its commands report through, the leases it reads, the identity
 * lookups the chat platforms redeem, and the request diary a setup flow
 * watches. No module ever names the database file: the runner opens it and
 * hands over the handle.
 */
export interface Store {
  readonly db: DatabaseSync;
  /** Open for the last time; closing it is the runner's, never a module's. */
  close(): void;
  /** Apply this namespace's migrations, once, in order; new tables belong to the module that named them. */
  migrate(namespace: string, steps: readonly string[]): void;
  /** Run one SQLite transaction; a throw rolls it back whole. */
  transaction<T>(fn: () => T): T;
  /** Leave one audit line on a run. */
  note(id: string, action: string, reason: string, now?: number): void;

  /** Run history: one job, one state, the newest few. */
  runs(filter?: RunFilter): Run[];
  /** One run by id; throws when it is not there. */
  run(id: string): Run;
  /** How many runs stand in each state. */
  counts(): Record<RunState, number>;
  /** One run of a task that should happen once now (a report, a re-entry). */
  enqueue(task: Task, resource: string, dedupeKey: string, now?: number, report?: Report | null): Run;

  /** Every job as the store holds it: definition, source, state, next instant. */
  jobs(): JobEntry[];
  /** The job defined under `id`; throws when it is not there. */
  job(id: string): JobEntry;
  /** Reconcile the definitions with `config.json` and the host's system jobs. */
  syncJobs(config: Job[], system?: Job[], now?: number): void;
  /** Define a job from an agent tool call or the operator CLI. */
  addJob(spec: Job, source: 'agent' | 'operator', now?: number, options?: AddJobOptions): JobEntry;
  setJobEnabled(id: string, enabled: boolean, now?: number): JobEntry;
  removeJob(id: string, now?: number): void;
  /** Run a job now, beside its schedule. */
  runJob(id: string, now?: number): Run;
  /** Materialize occurrences that came due while aivi slept; silence is a result. */
  materializeDue(now?: number, graceMs?: number): { created: number; missed: Run[] };

  /** The scheduler's claim: one run of one resource, under the capacity ceilings. */
  claim(owner: string, maxConcurrent: number, resources: Record<string, number>, now?: number): Run | null;
  /** Resources whose queue could take another claim. */
  queuedResources(): string[];
  /** The next occurrence to materialize; null when nothing is due. */
  nextDue(now?: number): number | null;
  acquireLease(
    id: string,
    owner: string,
    resource: string,
    maxConcurrent: number,
    resources: Record<string, number>,
    onAcquire?: () => void,
    now?: number,
  ): boolean;
  releaseLease(id: string, owner: string): void;
  blockLease(id: string, owner: string, reason: string): void;
  blockLeasesOwnedBy(owner: string, reason: string): number;
  /** Every held lease, as the module CLIs report them. */
  leases(): Lease[];
  leaseCount(): number;
  /** Name the session a claimed run opened, so reports can find their way back. */
  attachSession(id: string, owner: string, sessionId: string): void;
  /** Settle a claimed run: its result, its state, its reason. */
  finish(
    id: string,
    owner: string,
    state: 'succeeded' | 'failed' | 'blocked',
    result: unknown,
    reason: string,
    now?: number,
  ): void;
  cancelQueued(id: string, now?: number): void;
  /** A person answered what a blocked run awaited; the run resumes its outcome. */
  resolveBlocked(id: string, outcome: 'succeeded' | 'failed', reason: string, now?: number): void;
  /** The one live host: a second serve finds the daemon held and steps back. */
  acquireDaemon(owner: string, pid?: number, now?: number): void;
  releaseDaemon(owner: string): void;

  /** A run's audit trail, oldest first. */
  history(id: string): AuditEntry[];
  /** Runs that reached a final state since `since`, newest first. */
  recent(since: number, limit?: number): Run[];
  lastRun(jobId: string): Run | null;
  /** Consecutive failed runs of a job; the streak a report's nudge reads. */
  failureStreak(jobId: string): number;
  /** Tell a running run a person asked it to stop. */
  requestCancel(id: string, now?: number): void;
  /** The runs this owner was told to stop and has not felt yet. */
  cancelRequested(owner: string): string[];
  /** Drop history older than the instant; the counts say what left. */
  prune(olderThan: number): { runs: number; jobs: number; linkCodes: number };

  /** The people directory: `aivi people`, and the tokens they sign in with. */
  createPerson(spec: { name: string; email?: string | null; roles?: string[] }, now?: number): Person;
  person(id: string): Person | null;
  people(): Person[];
  mintToken(personId: string, label: string, now?: number): { token: PersonToken; secret: string };
  personForToken(secret: string): { person: Person; token: PersonToken } | null;
  /** A link code a person spends on a chat platform; the expiry is the answer. */
  mintLinkCode(personId: string, ttlMs?: number, now?: number): { code: string; expiresAt: number };
  redeemLinkCode(
    code: string,
    channel: string,
    userId: string,
    now?: number,
  ):
    | { reason: 'bound'; person: Person }
    | { reason: 'already'; person: Person }
    | { reason: 'expired' }
    | { reason: 'unknown' };
  /** The person behind a platform identity, if aivi knows one. */
  identityFor(channel: string, userId: string): Person | null;
  personLinkedIn(channel: string, personId: string): boolean;

  /** Record one call the host answered; the diary a setup flow watches. */
  logRequest(entry: Omit<RequestLogEntry, 'id'>): void;
  requests(filter?: { sinceId?: number; method?: string; path?: string; limit?: number }): RequestLogEntry[];
  clearRequests(olderThan: number): number;
}

/**
 * The run machinery as a module meets it: a tracker registers its stages,
 * wakes the walk, stops and answers runs, and reads run records. Work is
 * never handed in here — the walk over the tracker's board is the only door
 * for board work (ruled 2026-10-01). The orchestrator itself is the host's
 * class, checked against this interface.
 */
export interface Orchestrator {
  /** Register the one tracker a module speaks for. */
  addTracker(tracker: Tracker): void;
  /** Walk the board now: the whole set, or one project. */
  wake(projectId?: string): Promise<void>;
  /** Stop a running run; the run ends `cancelled` and says so where people read. */
  stop(runId: string, reason: string): Promise<void>;
  /** A person's answer to a parked run; `formId` is the OpenCode form it answers. */
  answer(
    sessionId: string,
    text: string,
    formId?: string,
  ): Promise<{ resumed: true } | { resumed: false; queued?: string; refused?: string }>;
  /** The run working `ticketId` for `trackerId`, if one is in flight. */
  activeRun(trackerId: string, ticketId: string): RunView | undefined;
  /** The run a worker session belongs to, whatever tracker spoke for it. */
  runBySession(sessionId: string): RunView | undefined;
  /** Forget a waiting request: a person moved the ticket themselves. */
  cancelWaiting(trackerId: string, ticketId: string): void;
}

/**
 * What a public route sees: the request and its raw body (signatures are
 * computed over bytes, never re-serialized JSON). Headers are the plain
 * lower-cased view the API has always handed over.
 */
export interface PublicRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}
export type PublicRouteHandler = (request: PublicRequest) => Promise<{ status: number; body?: unknown }>;

/**
 * Routes a module exposes without the bearer token: webhooks from platforms
 * that authenticate with their own signature. A path is owned by one handler;
 * registering it twice is a programming error. `/health` and `/version` are
 * the only other unauthenticated routes, and no module may take them. The
 * registry is the host's class, checked against this interface.
 */
export interface PublicRoutes {
  register(path: string, handler: PublicRouteHandler): () => void;
}

export type TaskHandler = (run: Run, context: ExecutionContext) => Promise<ExecutionResult>;

/** What `kind: 'invocation'` tasks dispatch to: the host claims its own
 *  operations here, modules claim theirs. */
export interface TaskClaims {
  claim(name: string, handler: TaskHandler): void;
  release(name: string): void;
}

/** One call as the generic dispatch hands it over: the envelope's ids, the model's input. */
export interface ToolCall {
  sessionId: string;
  messageId?: string;
  input: Record<string, unknown>;
}
export type ToolHandler = (call: ToolCall) => Promise<unknown>;

/** The tool surface the OpenCode plugin registers at load: the host claims
 *  its own tools here, modules claim theirs. */
export interface ToolClaims {
  claim(descriptor: ToolDescriptor, handler: ToolHandler): void;
  release(id: string): void;
}

/** The shape every OpenCode event shares; session events carry `data.sessionID`. */
export interface SessionEvent {
  type: string;
  data?: { sessionID?: string } & Record<string, unknown>;
}
export type SessionEventListener = (event: SessionEvent) => void;

/** The host's one OpenCode event stream, fanned out by session id. */
export interface SessionEvents {
  /** Receive this session's events until the returned function is called. */
  watch(sessionID: string, listener: SessionEventListener): () => void;
}
