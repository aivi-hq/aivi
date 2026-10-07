import { randomBytes } from 'node:crypto';
import { type Config, errorMessage, getLogger, type Logger } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin/module';
import type { FailureCode } from '@aivi/plugin/run';
import { Ref } from '@opencode/schema/model';
import { agentModel, type NativeModel } from '../session.ts';
import { type DispatcherLease, type LeaseStore, UNLIMITED } from './leases.ts';

export type { DispatcherLease };

/**
 * The dispatcher: the only part that knows how much capacity is left
 * (docs/orchestrator.md). Everything that wants to spend — the orchestrator
 * first, later the channels, jobs and the dreamer — asks here for a lease
 * and works with what it is granted; nobody counts slots themselves.
 *
 * What the dispatcher is **not**: no queue yet (the in-memory wait-list is
 * the next step; a full pool answers `refused` today and the caller decides),
 * no timers (the timeout monitor arms its own known-instant waits around
 * `expire`), and no knowledge of tickets (the orchestrator's claim mirrors a
 * lease here; the dispatcher never learns what a ticket is).
 *
 * The durable facts are the lease store's; this class is the state machine:
 * it is the part that creates and consults OpenCode sessions.
 */

/** Why a request did not get a slot — and did not get a queue place
 *  either. `full` is ordinary pressure from a service nobody registered
 *  to hear (an un-waitable refusal); `waiting` says this service already
 *  holds the pool's one queue place; `pool-gone` is a config that outran
 *  reality and says so. */
export type Refusal = 'full' | 'pool-gone' | 'waiting';

/** A lease request waiting in the pool's in-memory queue: not a lease,
 *  holding no capacity, deliberate to lose — a restart simply lets the
 *  callers ask again for work that is still relevant. */
interface QueuedRequest {
  id: string;
  service: string;
  pool: string;
  resume?: string;
}

/** A service's callback namespace: when a waiting request becomes a
 *  lease, the dispatcher calls its service with the request id and the
 *  lease. The callback is also the wake: look for more work. */
export type LeaseCallback = (requestId: string, lease: DispatcherLease) => void;

export interface DispatcherDeps {
  leases: LeaseStore;
  /** The config root's `dispatcher` block: pools and killAttempts, as loaded. */
  dispatcher: Config['dispatcher'];
  /** Milliseconds, the numbers the config load parsed from its durations:
   *  the two clocks every lease watches. The unit takes numbers and waits
   *  on numbers — the strings are a person's config surface, not this
   *  unit's, and a test runs these clocks at 30ms without touching the
   *  duration grammar. */
  idleMs: number;
  prepareMs: number;
  opencode: () => Promise<OpenCodeClient>;
  /** Host-wide: every OpenCode call dies with the host, not on a watch of its own. */
  signal?: AbortSignal;
  log?: Logger;
  /** The dispatcher ended a lease itself; the owner is told (for ticket work
   *  the orchestrator clears the claim that mirrored it). Per-service
   *  callback namespaces land with the queue; this is that seam. */
  onEnded?: (lease: DispatcherLease, reason: string, code?: FailureCode) => void;
}

/** `provider/model[#variant]`: OpenCode's own spelling, parsed by OpenCode's
 *  own `Ref.parse` — the one the agent-file frontmatter goes through. A name
 *  the pool cannot answer with is said at startup, never at a grant. */
const parseModelSpec = (spec: string): NativeModel => {
  const ref = Ref.parse(spec);
  return { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) };
};

export class Dispatcher {
  readonly leases: LeaseStore;
  private readonly deps: DispatcherDeps;
  private readonly pools: NonNullable<Config['dispatcher']['pools']>;
  private readonly log: Logger;
  /** Milliseconds, parsed once: the same durations the config load accepted. */
  private readonly idleMs: number;
  private readonly prepareMs: number;
  /** How hard to strike a session that will not die, before giving up on
   *  it: each strike lands at a known instant (the retry clock), never as
   *  a poll. After the last one the slot is taken back anyway and the
   *  ending is said with a machine-readable code — a worker may still be
   *  loose, and a person should know. */
  private readonly killAttempts: number;
  /** Kill strikes counted per lease, cleared the moment the kill confirms
   *  or the lease ends any other way. */
  private readonly strikes = new Map<string, number>();
  /** One timer per lease: the known instant its current clock expires,
   *  re-armed by grants, sessions and signs of life — never a poll, never
   *  an interval. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Waiting lease requests per pool, in the order they asked. */
  private readonly waiting = new Map<string, QueuedRequest[]>();
  private readonly pending = new Map<string, QueuedRequest>();
  private readonly callbacks = new Map<string, LeaseCallback>();

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.leases = deps.leases;
    this.log = (deps.log ?? getLogger(['aivi', 'dispatcher'])).with({});
    this.pools = deps.dispatcher.pools ?? {};
    this.idleMs = deps.idleMs;
    this.prepareMs = deps.prepareMs;
    this.killAttempts = deps.dispatcher.killAttempts;
    // A pool model is checked at startup, not at the grant that would need it.
    for (const pool of Object.values(this.pools)) if (pool.model !== undefined) parseModelSpec(pool.model);
    // Shutting down: every armed clock goes with it. Nothing fires into a
    // dispatcher whose host is ending; the boot pass re-arms the survivors.
    deps.signal?.addEventListener('abort', () => this.#disarmAll(), { once: true });
  }

  /**
   * (Re-)set a lease's one timer to its known instant. Any earlier clock
   * for this lease dies: there is never more than one future for a lease.
   */
  #arm(leaseId: string, due: number, now = Date.now()): void {
    const previous = this.timers.get(leaseId);
    if (previous) clearTimeout(previous);
    const handle = setTimeout(
      () => {
        this.timers.delete(leaseId);
        void this.#due(leaseId).catch(error => this.log.warn('monitor.failed', { lease: leaseId, error }));
      },
      Math.max(0, due - now),
    );
    this.timers.set(leaseId, handle);
  }

  #disarm(leaseId: string): void {
    const previous = this.timers.get(leaseId);
    if (previous) clearTimeout(previous);
    this.timers.delete(leaseId);
  }

  #disarmAll(): void {
    for (const previous of this.timers.values()) clearTimeout(previous);
    this.timers.clear();
  }

  /** Arm a lease's clock from its own record: a session-less lease is due
   *  `prepare` after it was granted — the caller had that long to bring the
   *  session; an attached one is due `idle` after its last sign of life,
   *  which after a restart is the stored one, when the silence truly
   *  started.
   */
  #armFrom(lease: DispatcherLease, now = Date.now()): void {
    if (!lease.sessionId) this.#arm(lease.id, lease.createdAt + this.prepareMs, now);
    else this.#arm(lease.id, lease.activityAt + this.idleMs, now);
  }

  /**
   * The instant arrived. The lease gets its documented ending: a
   * session-less lease is revoked — nothing was provided to kill; an
   * attached one is killed and confirmed through the same `expire` every
   * other ending uses. An **unconfirmed kill keeps the slot unavailable**
   * — capacity that may still be working is never double-booked — and the
   * next look is a known instant, not a poll: the retry re-arms the one
   * timer and interrupts again.
   */
  async #due(leaseId: string): Promise<void> {
    const lease = this.leases.get(leaseId);
    if (!lease) return; // ended while the clock flew: nothing is due twice
    if (!lease.sessionId) {
      // The prepare clock needs no cap: there is nothing to kill.
      await this.expire(leaseId, 'no session was provided within the prepare timeout');
      return;
    }
    const strikes = (this.strikes.get(leaseId) ?? 0) + 1;
    this.strikes.set(leaseId, strikes);
    const outcome = await this.expire(leaseId, 'its session said nothing for longer than the idle timeout');
    if ('pending' in outcome) {
      if (strikes >= this.killAttempts) return void this.#giveUp(lease, strikes);
      this.#arm(leaseId, Date.now() + this.idleMs);
    }
  }

  /**
   * The last strike missed: give up on the session, not on the slot. The
   * lease ends and the capacity returns — a dispatcher that loses a whole
   * pool to one stubborn session helps nobody — but the ending carries the
   * `kill-unconfirmed` code: whoever owns the work says so loudly and a
   * person goes looking. The session is left alive; killing it is no
   * longer the dispatcher's war.
   */
  #giveUp(lease: DispatcherLease, strikes: number): void {
    this.strikes.delete(lease.id);
    this.#free(lease);
    this.log.warn('kill.gave-up', { lease: lease.id, session: lease.sessionId, strikes });
    this.deps.onEnded?.(
      lease,
      `the session did not stop after ${strikes} kill attempt${strikes === 1 ? '' : 's'}`,
      'kill-unconfirmed',
    );
  }

  /** Capacity is moderated only when pools are configured; without them the
   *  dispatcher still tracks every lease (sessions still need watching) but
   *  every request is granted — unlimited, the intended default. */
  get moderated(): boolean {
    return Object.keys(this.pools).length > 0;
  }

  /**
   * Ask for a slot. A **new** session walks the pool's fallback chain and is
   * created in the first pool with room — the fallback grant is for new
   * sessions only. A **resume** (the session is known here) must return to
   * the pool that session was created in: running it elsewhere would change
   * its model and lose its prefill cache, so a full original pool waits in
   * that pool's queue even when a fallback has room.
   *
   * A full pool **accepts** the request into its queue — `queued` with the
   * id that cancels it — because a queued request is the answer to
   * "give me a slot when one opens". Once a service holds the pool's one
   * queue place, further requests from that service for the same pool are
   * refused: the caller stops asking that pool this pass. A service nobody
   * registered to hear gets the plain `full`: there would be no one to
   * hand the freed slot to, and a lease nobody was told about is a leak,
   * not a queue.
   */
  request(
    input: { service: string; pool?: string; resume?: string },
    now = Date.now(),
  ): { lease: DispatcherLease } | { queued: string } | { refused: Refusal; pool: string } {
    if (!this.moderated) return this.#grantUnlimited(input, now);
    // A session's own pool outranks whatever the caller asks for; only when
    // the session is unknown here does the asked-for pool decide, and an
    // unknown *name* is a caller bug said as such, not pressure.
    const recorded = input.resume ? this.leases.sessionPool(input.resume) : undefined;
    if (recorded !== undefined && !(recorded in this.pools)) return { refused: 'pool-gone', pool: recorded };
    const asked = input.pool ?? 'default';
    if (recorded === undefined && !(asked in this.pools))
      throw new Error(
        `pool "${asked}" is not configured; name one of ${Object.keys(this.pools).join(', ')} or configure a "default"`,
      );
    // A resume gets its session's own pool and nothing else; a new session
    // walks the fallback chain, which the config load proved cycle-free.
    const targets = input.resume ? [recorded ?? asked] : this.#chain(asked);
    const lease = this.#grantOnTargets(input, targets, now);
    if (lease) {
      if (input.resume) this.leases.record(input.resume, lease.pool, now);
      return { lease };
    }
    return this.#queue(input.service, recorded ?? asked, input.resume);
  }

  /** The first pool on the targets that has a slot: grant it and arm the
   *  lease's clocks. No target has one — the answer callers act on. */
  #grantOnTargets(
    what: { service: string; resume?: string },
    targets: string[],
    now = Date.now(),
  ): DispatcherLease | undefined {
    for (const pool of targets) {
      const lease = this.leases.grant(
        {
          kind: 'session',
          service: what.service,
          pool,
          capacity: this.pools[pool]!.capacity,
          ...(what.resume ? { sessionId: what.resume } : {}),
        },
        () => {},
        now,
      );
      if (lease) {
        this.#armFrom(lease, now);
        return lease;
      }
    }
    return undefined;
  }

  /** Unmoderated: no capacity check exists to fail, so the grant always
   *  lands. The timeouts still watch — a silent worker dies at its idle
   *  clock whether or not anyone is counting slots. */
  #grantUnlimited(input: { service: string; resume?: string }, now: number): { lease: DispatcherLease } {
    const lease = this.leases.grant(
      {
        kind: 'session',
        service: input.service,
        pool: UNLIMITED,
        ...(input.resume ? { sessionId: input.resume } : {}),
      },
      () => {},
      now,
    )!;
    this.#armFrom(lease, now);
    return { lease };
  }

  /** Take the queue place, or say this service holds it already. */
  #queue(service: string, pool: string, resume?: string): { queued: string } | { refused: Refusal; pool: string } {
    if (!this.callbacks.has(service)) return { refused: 'full', pool };
    const waiting = this.waiting.get(pool) ?? [];
    if (waiting.some(request => request.service === service)) return { refused: 'waiting', pool };
    const request: QueuedRequest = {
      id: `req_${randomBytes(5).toString('hex')}`,
      service,
      pool,
      ...(resume ? { resume } : {}),
    };
    waiting.push(request);
    this.waiting.set(pool, waiting);
    this.pending.set(request.id, request);
    return { queued: request.id };
  }

  /**
   * One callback namespace per service (docs/orchestrator.md): the
   * orchestrator registers itself and hears when a waiting request of
   * its own becomes a lease. Registering is also what makes a pool's
   * fullness waitable at all.
   */
  registerCallback(service: string, callback: LeaseCallback): void {
    this.callbacks.set(service, callback);
  }

  /**
   * Lose the queue place and nothing more. A request already granted is
   * no longer cancellable — its lease is released, not its place — and an
   * unknown id (a restart's) was already lost: the queue is ephemeral.
   */
  cancel(requestId: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    const waiting = this.waiting.get(request.pool);
    if (!waiting) return;
    const at = waiting.findIndex(request => request.id === requestId);
    if (at >= 0) waiting.splice(at, 1);
    if (waiting.length === 0) this.waiting.delete(request.pool);
  }

  /** A pool and its fallbacks, in grant order; the load proved chains end. */
  #chain(start: string): string[] {
    const names: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined) {
      names.push(at);
      at = this.pools[at]!.fallback;
    }
    return names;
  }

  /** End the lease and open its slot to the queue: the freed capacity goes
   *  to the next request of this pool, in the order they asked. */
  #free(lease: DispatcherLease): void {
    this.#disarm(lease.id);
    this.strikes.delete(lease.id); // the war on this lease is over, one way or another
    this.leases.release(lease.id);
    this.#drain(lease.pool);
  }

  /**
   * A slot opened: the requests waiting in this pool walk in, in the order
   * they asked — a resume only into its own pool (the fallback is for new
   * sessions), a new session down the chain again. Each grant is said to
   * the service's callback namespace with its request id and its lease;
   * the callback is also the wake that says *look for more work*. A grant
   * that finds no capacity leaves everyone waiting: the queue is FIFO and
   * waits for its own pool, not for whichever request fits best.
   */
  #drain(pool: string): void {
    const waiting = this.waiting.get(pool);
    if (!waiting) return;
    while (waiting.length > 0) {
      const next = waiting[0]!;
      const targets = next.resume ? [this.leases.sessionPool(next.resume) ?? next.pool] : this.#chain(next.pool);
      const granted = this.#grantOnTargets(next, targets);
      if (!granted) return; // full again: the rest of the queue keeps waiting
      waiting.shift();
      if (waiting.length === 0) this.waiting.delete(pool);
      this.pending.delete(next.id);
      if (next.resume) this.leases.record(next.resume, granted.pool);
      const callback = this.callbacks.get(next.service);
      if (!callback) continue; // granted blind: the reconcile pass is its net
      void Promise.resolve(callback(next.id, granted)).catch(error =>
        this.log.warn('callback.failed', { service: next.service, request: next.id, error }),
      );
    }
  }

  /**
   * Provide the lease with its session: create it, or resume one the caller
   * brings, and attach it. The pool decides the model at session create
   * (ruled 2026-10-02); the agent file's own model wins only in a pool that
   * names none — and in unlimited mode, which names none at all. A resumed
   * session keeps whatever it was born with: nobody re-decides a model.
   */
  async provide(
    leaseId: string,
    work: { agent: string; directory: string; sessionId?: string },
  ): Promise<DispatcherLease> {
    const lease = this.leases.require(leaseId);
    if (lease.state !== 'preparing')
      throw new Error(`lease ${leaseId} is ${lease.state}; only a preparing lease is provided with a session`);
    const client = await this.deps.opencode();
    const request = { signal: this.deps.signal ?? AbortSignal.timeout(30_000) };
    let sessionId = work.sessionId;
    if (sessionId) {
      const session = await client.session.get({ sessionID: sessionId }, request);
      if (session.agent !== work.agent || session.location.directory !== work.directory)
        throw new Error(`session ${sessionId} no longer runs agent ${work.agent} in ${work.directory}`);
    } else {
      // The id names the service: whose worker a session is stays readable
      // in OpenCode's own list, and tests can point at one kind of session.
      sessionId = `ses_${lease.service}_${randomBytes(10).toString('hex')}`;
      const spec = this.pools[lease.pool]?.model;
      const model = spec ? parseModelSpec(spec) : await agentModel(client, work.agent, work.directory, request);
      await client.session.create(
        { id: sessionId, agent: work.agent, location: { directory: work.directory }, ...(model ? { model } : {}) },
        request,
      );
    }
    const attached = this.leases.attach(leaseId, sessionId);
    this.leases.record(sessionId, attached.pool);
    this.#armFrom(attached); // the idle clock starts where the provide ends
    return attached;
  }

  /**
   * The caller is done with its slot. Ending a lease never deletes the
   * session — the session outlives turns and leases, and whether it is
   * kept is nobody's business here. The freed slot goes to the queue.
   *
   * An **expiring** lease takes the same rule as every other ending (ruled
   * 2026-10-03): the dispatcher was already killing its session, and
   * capacity that may still be spending is never double-booked — so the
   * kill is **confirmed before the slot is released**. Confirmed, the slot
   * ends through the usual door and the queue is woken; unconfirmed, the
   * slot stays held, the lease stays expiring, and the same strike clock
   * the idle monitor uses keeps trying, ending loudly with
   * `kill-unconfirmed` when the attempts run out.
   */
  async release(leaseId: string): Promise<{ ended: DispatcherLease } | { pending: DispatcherLease }> {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`Lease ${leaseId} was already gone`);
    if (lease.state !== 'expiring') {
      this.#disarm(leaseId);
      this.strikes.delete(leaseId);
      this.leases.release(leaseId);
      this.#drain(lease.pool);
      return { ended: lease };
    }
    const outcome = await this.expire(leaseId, 'the caller released a lease whose kill was not yet confirmed');
    if ('ended' in outcome) return outcome;
    // Untouched means not ended, not unwatched: the confirmation keeps its
    // known-instant retries, the same clock an idle expiry re-arms on.
    this.#arm(leaseId, Date.now() + this.idleMs);
    return outcome;
  }

  /** A sign of life on the lease's session: the idle monitor's clock
   *  restarts here, whatever the caller was doing. */
  activity(leaseId: string, now = Date.now()): void {
    this.leases.touch(leaseId, now);
    if (this.leases.get(leaseId)) this.#arm(leaseId, now + this.idleMs, now);
  }

  /**
   * End a lease the dispatcher decided to end — the prepare timeout on a
   * session-less lease, the idle timeout or a boot reconcile on an attached
   * one. An attached session is **killed before the slot is freed**: the
   * interrupt goes first, and until it is confirmed — the session is no
   * longer spending — the slot stays held, because capacity that may still
   * be working must not be double-booked.
   */
  async expire(leaseId: string, reason: string): Promise<{ ended: DispatcherLease } | { pending: DispatcherLease }> {
    const lease = this.leases.require(leaseId);
    if (!lease.sessionId) {
      this.#free(lease);
      this.deps.onEnded?.(lease, reason);
      return { ended: lease };
    }
    if (lease.state === 'active') this.leases.beginExpiry(leaseId);
    const client = await this.deps.opencode();
    const request = { signal: this.deps.signal ?? AbortSignal.timeout(15_000) };
    await client.session
      .interrupt({ sessionID: lease.sessionId }, request)
      .catch(error => this.log.warn('expire.interrupt.failed', { lease: leaseId, error }));
    if (await this.#spent(client, lease.sessionId, request)) {
      const held = this.leases.require(leaseId);
      this.#free(held);
      this.deps.onEnded?.(held, reason);
      return { ended: held };
    }
    this.log.warn('expire.unconfirmed', { lease: leaseId, session: lease.sessionId });
    return { pending: this.leases.require(leaseId) };
  }

  /**
   * Boot: the rows survived; check them against OpenCode's reality before
   * granting anything new. If the server itself does not answer — or there
   * is no server to even build a client for (`lifecycle: "discover"` with
   * none registered) — the pass is **deferred whole**: silence from OpenCode
   * is not proof that work died, and releasing every lease on a network
   * hiccup would be the dispatcher's own double-booking bug. A host whose
   * OpenCode is unreachable still boots and serves.
   *
   * - preparing past the prepare timeout: revoked (no session to kill).
   * - attached and its session is gone: released.
   * - expiring (a kill that never got confirmed): confirmed now, or retried.
   * - attached and alive: kept as it was; the monitor re-arms from the
   *   stored activity, which is when the silence truly started.
   */
  async reconcile(
    now = Date.now(),
  ): Promise<{ ended: { lease: DispatcherLease; reason: string }[]; deferred: boolean }> {
    const ended: { lease: DispatcherLease; reason: string }[] = [];
    // Building the client can itself fail when there is nothing to point at;
    // that is the same silence as a server that does not answer.
    let client: OpenCodeClient;
    try {
      client = await this.deps.opencode();
    } catch (error) {
      this.log.warn('reconcile.deferred', {
        reason: `OpenCode could not be reached: ${errorMessage(error)}; leases stand untouched`,
      });
      for (const lease of this.leases.all()) this.#armFrom(lease, now);
      return { ended: [], deferred: true };
    }
    const request = { signal: this.deps.signal ?? AbortSignal.timeout(15_000) };
    // Even with no pools to count, the pass reads OpenCode's reality; a
    // server that does not answer gets its leases left alone, not a purge.
    if (!(await this.#reachable(client, request))) {
      this.log.warn('reconcile.deferred', { reason: 'OpenCode did not answer; leases stand untouched' });
      // Untouched means not ended, not unwatched: the clocks arm anyway,
      // and an expiring lease that cannot confirm its kill keeps waiting.
      for (const lease of this.leases.all()) this.#armFrom(lease, now);
      return { ended: [], deferred: true };
    }
    for (const lease of this.leases.all()) {
      const verdict = await this.#verdict(lease, now, client, request);
      if (verdict) ended.push(...(await this.#endedBy(lease, verdict, client, request)));
    }
    for (const { lease, reason } of ended) this.log.info('lease.reconciled', { lease: lease.id, reason });
    // The survivors get their clocks re-armed from their stored activity:
    // a silence that started before the restart is timed from where it
    // started, not from the boot that read it.
    for (const lease of this.leases.all()) this.#armFrom(lease, now);
    return { ended, deferred: false };
  }

  /** Why this lease stands no more, in the words the person hears — or
   *  nothing yet. An expiring lease is passed back untouched for the
   *  caller's kill-confirmation dance: its ending rides on OpenCode's
   *  answer, not on this read. */
  async #verdict(
    lease: DispatcherLease,
    now: number,
    client: OpenCodeClient,
    request: { signal: AbortSignal },
  ): Promise<{ reason: string } | { expiring: true } | undefined> {
    if (this.moderated && !(lease.pool in this.pools)) return { reason: 'its pool is no longer configured' };
    if (!lease.sessionId)
      return now - lease.createdAt >= this.prepareMs
        ? { reason: 'no session was provided within the prepare timeout' }
        : undefined;
    if (lease.state === 'expiring') return { expiring: true };
    const alive = await client.session
      .get({ sessionID: lease.sessionId }, request)
      .then(() => true)
      .catch(() => false);
    return alive ? undefined : { reason: 'its OpenCode session is gone' };
  }

  /** Apply a verdict: the books free the lease, the service is told, and
   *  what ended comes back for the pass's record. An expiring lease is the
   *  kill-confirmation dance: confirmed it ends here, unconfirmed it is
   *  retried through `expire`, which may itself end it. */
  async #endedBy(
    lease: DispatcherLease,
    verdict: { reason: string } | { expiring: true },
    client: OpenCodeClient,
    request: { signal: AbortSignal },
  ): Promise<{ lease: DispatcherLease; reason: string }[]> {
    if ('expiring' in verdict) {
      if (await this.#spent(client, lease.sessionId!, request)) {
        this.#free(lease);
        this.deps.onEnded?.(lease, 'the kill was confirmed');
        return [{ lease, reason: 'the kill was confirmed' }];
      }
      const retry = await this.expire(lease.id, 'the kill is being retried after the boot pass');
      return 'ended' in retry ? [{ lease: retry.ended, reason: 'the kill was confirmed on retry' }] : [];
    }
    this.#free(lease);
    this.deps.onEnded?.(lease, verdict.reason);
    return [{ lease, reason: verdict.reason }];
  }

  /** Is this session done spending? Absent from the active set — killed,
   *  idle, or gone entirely — is confirmation. An unreadable active set is
   *  never confirmation: the slot stays held rather than risk double-book. */
  async #spent(client: OpenCodeClient, sessionId: string, request: { signal: AbortSignal }): Promise<boolean> {
    try {
      const active = await client.session.active(request);
      return !(sessionId in active);
    } catch (error) {
      this.log.warn('active.set.unreadable', { error: errorMessage(error) });
      return false;
    }
  }

  /** One cheap read that says whether OpenCode answers at all. */
  async #reachable(client: OpenCodeClient, request: { signal: AbortSignal }): Promise<boolean> {
    return client.session
      .active(request)
      .then(() => true)
      .catch(() => false);
  }
}
