import { randomBytes } from 'node:crypto';
import { type Config, errorMessage, getLogger, type Logger, parseDuration } from '@aivi/core';
import type { OpenCodeClient } from '../opencode.ts';
import { agentModel, type NativeModel } from '../session.ts';
import { type DispatcherLease, type LeaseStore, UNLIMITED } from './leases.ts';

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

/** Why a request did not get a slot. `full` is ordinary pressure — the
 *  caller queues or moves on; `pool-gone` is a config that outran reality
 *  and says so. */
export type Refusal = 'full' | 'pool-gone';

export interface DispatcherDeps {
  leases: LeaseStore;
  /** The config root's `dispatcher` block: pools and timeouts, as loaded. */
  dispatcher: Config['dispatcher'];
  opencode: () => Promise<OpenCodeClient>;
  /** Host-wide: every OpenCode call dies with the host, not on a watch of its own. */
  signal?: AbortSignal;
  log?: Logger;
  /** The dispatcher ended a lease itself; the owner is told (for ticket work
   *  the orchestrator clears the claim that mirrored it). Per-service
   *  callback namespaces land with the queue; this is that seam. */
  onEnded?: (lease: DispatcherLease, reason: string) => void;
}

/** `provider/model[@variant]`, the one spelling pools use; a name the pool
 *  cannot answer with is said at startup, never at a grant. */
function parseModelSpec(spec: string): NativeModel {
  const at = spec.indexOf('/');
  const [providerID, rest] = at < 0 ? ['', spec] : [spec.slice(0, at), spec.slice(at + 1)];
  const [modelID, variant] = rest?.includes('@') ? (rest.split('@') as [string, string]) : [rest, undefined];
  if (!providerID || !modelID)
    throw new Error(`dispatcher pool model "${spec}" must read provider/model (or provider/model@variant)`);
  return { providerID, id: modelID, ...(variant ? { variant } : {}) };
}

export class Dispatcher {
  readonly leases: LeaseStore;
  private readonly deps: DispatcherDeps;
  private readonly pools: NonNullable<Config['dispatcher']['pools']>;
  private readonly log: Logger;
  /** Milliseconds, parsed once: the same durations the config load accepted. */
  private readonly idleMs: number;
  private readonly prepareMs: number;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.leases = deps.leases;
    this.log = (deps.log ?? getLogger(['aivi', 'dispatcher'])).with({});
    this.pools = deps.dispatcher.pools ?? {};
    this.idleMs = parseDuration(deps.dispatcher.timeouts.idle);
    this.prepareMs = parseDuration(deps.dispatcher.timeouts.prepare);
    // A pool model is checked at startup, not at the grant that would need it.
    for (const pool of Object.values(this.pools)) if (pool.model !== undefined) parseModelSpec(pool.model);
  }

  /** Capacity is moderated only when pools are configured; without them the
   *  dispatcher still tracks every lease (sessions still need watching) but
   *  every request is granted — unlimited, the intended default. */
  get moderated(): boolean {
    return Object.keys(this.pools).length > 0;
  }

  /** The idle timeout's reading: silence on an attached session may not
   *  pass this; an activity signal restarts it. */
  get idleTimeoutMs(): number {
    return this.idleMs;
  }

  /**
   * Ask for a slot. A **new** session walks the pool's fallback chain and is
   * created in the first pool with room — the fallback grant is for new
   * sessions only. A **resume** (the session is known here) must return to
   * the pool that session was created in: running it elsewhere would change
   * its model and lose its prefill cache, so a full original pool is a
   * refusal even when a fallback has room.
   */
  request(
    input: { service: string; pool?: string; resume?: string },
    now = Date.now(),
  ): { lease: DispatcherLease } | { refused: Refusal; pool: string } {
    if (!this.moderated)
      return {
        // No capacity check exists to fail: the grant always lands.
        lease: this.leases.grant(
          {
            kind: 'session',
            service: input.service,
            pool: UNLIMITED,
            ...(input.resume ? { sessionId: input.resume } : {}),
          },
          () => {},
          now,
        )!,
      };
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
    for (const pool of targets) {
      const lease = this.leases.grant(
        {
          kind: 'session',
          service: input.service,
          pool,
          capacity: this.pools[pool]!.capacity,
          ...(input.resume ? { sessionId: input.resume } : {}),
        },
        () => {},
        now,
      );
      if (!lease) continue;
      if (input.resume) this.leases.record(input.resume, lease.pool, now);
      return { lease };
    }
    return { refused: 'full', pool: recorded ?? asked };
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
      sessionId = `ses_${randomBytes(10).toString('hex')}`;
      const spec = this.pools[lease.pool]?.model;
      const model = spec ? parseModelSpec(spec) : await agentModel(client, work.agent, work.directory, request);
      await client.session.create(
        { id: sessionId, agent: work.agent, location: { directory: work.directory }, ...(model ? { model } : {}) },
        request,
      );
    }
    const attached = this.leases.attach(leaseId, sessionId);
    this.leases.record(sessionId, attached.pool);
    return attached;
  }

  /** A sign of life on the lease's session: the idle monitor's clock
   *  restarts here, whatever the caller was doing. */
  activity(leaseId: string, now = Date.now()): void {
    this.leases.touch(leaseId, now);
  }

  /** The caller is done with its slot. Ending a lease never deletes the
   *  session — the session outlives turns and leases, and whether it is
   *  kept is nobody's business here. */
  release(leaseId: string): void {
    this.leases.release(leaseId);
  }

  /**
   * End a lease the dispatcher decided to end — the prepare timeout on a
   * session-less lease, the idle timeout or a boot reconcile on an attached
   * one. An attached session is **killed before the slot is freed**: the
   * interrupt goes first, and until it is confirmed — the session is no
   * longer spending — the slot stays held, because capacity that may still
   * be working must not be double-booked.
   */
  async expire(
    leaseId: string,
    reason: string,
    now = Date.now(),
  ): Promise<{ ended: DispatcherLease } | { pending: DispatcherLease }> {
    const lease = this.leases.require(leaseId);
    if (!lease.sessionId) {
      this.leases.release(leaseId);
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
      this.leases.release(leaseId);
      this.deps.onEnded?.(held, reason);
      return { ended: held };
    }
    this.log.warn('expire.unconfirmed', { lease: leaseId, session: lease.sessionId });
    return { pending: this.leases.require(leaseId) };
  }

  /**
   * Boot: the rows survived; check them against OpenCode's reality before
   * granting anything new. If the server itself does not answer, the pass
   * is **deferred whole** — silence from OpenCode is not proof that work
   * died, and releasing every lease on a network hiccup would be the
   * dispatcher's own double-booking bug.
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
    const client = await this.deps.opencode();
    const request = { signal: this.deps.signal ?? AbortSignal.timeout(15_000) };
    // Even with no pools to count, the pass reads OpenCode's reality; a
    // server that does not answer gets its leases left alone, not a purge.
    if (!(await this.#reachable(client, request))) {
      this.log.warn('reconcile.deferred', { reason: 'OpenCode did not answer; leases stand untouched' });
      return { ended: [], deferred: true };
    }
    for (const lease of this.leases.all()) {
      let reason: string | undefined;
      if (this.moderated && !(lease.pool in this.pools)) reason = 'its pool is no longer configured';
      else if (!lease.sessionId) {
        if (now - lease.createdAt >= this.prepareMs) reason = 'no session was provided within the prepare timeout';
      } else if (lease.state === 'expiring') {
        if (await this.#spent(client, lease.sessionId, request)) reason = 'the kill was confirmed';
        else {
          const retry = await this.expire(lease.id, 'the kill is being retried after the boot pass');
          if ('ended' in retry) ended.push({ lease: retry.ended, reason: 'the kill was confirmed on retry' });
        }
      } else {
        const alive = await client.session
          .get({ sessionID: lease.sessionId }, request)
          .then(() => true)
          .catch(() => false);
        if (!alive) reason = 'its OpenCode session is gone';
      }
      if (reason) {
        this.leases.release(lease.id);
        ended.push({ lease, reason });
        this.deps.onEnded?.(lease, reason);
      }
    }
    for (const { lease, reason } of ended) this.log.info('lease.reconciled', { lease: lease.id, reason });
    return { ended, deferred: false };
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
