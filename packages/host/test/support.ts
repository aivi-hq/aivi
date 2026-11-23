import type { Logger } from '@aivi/core';
import type { Dispatcher, DispatcherGrant, DispatcherLeaseRef } from '@aivi/plugin/dispatcher';

/**
 * A logger that keeps what was said: one entry per line, its fields beside
 * its `level` and `event`. `next(event)` settles with the first line of that
 * event, said already or still to come: the boundary to wait on when a
 * detached step is the one that speaks.
 */
export function recorder() {
  const lines: Record<string, unknown>[] = [];
  const firsts = new Map<string, PromiseWithResolvers<Record<string, unknown>>>();
  const first = (event: string) => firsts.get(event) ?? firsts.set(event, Promise.withResolvers()).get(event)!;
  const at = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    const line = { ...fields, level, event };
    lines.push(line);
    first(event).resolve(line);
  };
  const log = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    getChild: () => log,
    with: () => log,
  } as unknown as Logger;
  return {
    log,
    said: (level: string) => lines.filter(line => line.level === level),
    next: (event: string) => first(event).promise,
  };
}

/**
 * The dispatcher's contract as a test stand-in: a pool of `capacity` slots.
 * A request with room gets a lease (`preparing`, or `active` for a resume);
 * a full pool takes one queue place per service and refuses the service's
 * second ask with `waiting`. `release` pays the slot back and hands it to
 * the waiting place — the same synchronous drain the real dispatcher does,
 * so a test can watch a grant arrive through the registered callback.
 */
export class TestCapacity implements Dispatcher {
  /** Every lease granted, id → service: what capacity assertions count. */
  readonly granted = new Map<string, string>();
  readonly released: string[] = [];
  readonly cancelled: string[] = [];
  /** Every provide call, in order: {leaseId, agent, directory, sessionId, create}. */
  readonly provided: { leaseId: string; agent: string; directory: string; sessionId?: string; create?: boolean }[] = [];
  /** Pools whose name throws, like a pool absent from the config. */
  readonly throwing = new Set<string>();
  /** Slots a service may hold at once. */
  readonly capacity: number;
  private held = 0;
  private nextLease = 0;
  private nextRequest = 0;
  private readonly waiting: { id: string; service: string; pool: string; resume?: string }[] = [];
  private readonly callbacks = new Map<string, (requestId: string, lease: DispatcherLeaseRef) => void>();

  constructor(capacity: number = Number.POSITIVE_INFINITY) {
    this.capacity = capacity;
  }

  /** Slots held right now. */
  heldCount(): number {
    return this.held;
  }

  request(input: { service: string; pool?: string; resume?: string }): DispatcherGrant {
    const pool = input.pool ?? 'default';
    if (this.throwing.has(pool)) throw new Error(`pool "${pool}" is not configured`);
    if (this.held < this.capacity) {
      this.held++;
      return { lease: this.lease(input.service, pool, input.resume) };
    }
    if (this.waiting.some(request => request.service === input.service)) return { refused: 'waiting', pool };
    const id = `req_${++this.nextRequest}`;
    this.waiting.push({ id, service: input.service, pool, ...(input.resume ? { resume: input.resume } : {}) });
    return { queued: id };
  }

  provide(
    leaseId: string,
    work: { agent: string; directory: string; sessionId?: string; create?: boolean },
  ): Promise<DispatcherLeaseRef> {
    this.provided.push({ leaseId, ...work });
    return Promise.resolve({
      id: leaseId,
      pool: 'default',
      state: 'active',
      ...(work.sessionId ? { sessionId: work.sessionId } : {}),
    });
  }

  release(leaseId: string): Promise<{ ended: DispatcherLeaseRef } | { pending: DispatcherLeaseRef }> {
    this.released.push(leaseId);
    const service = this.granted.get(leaseId);
    if (service !== undefined) {
      this.granted.delete(leaseId);
      this.held--;
    }
    this.drain();
    return Promise.resolve({
      ended: { id: leaseId, pool: 'default', state: 'active' },
    });
  }

  registerCallback(service: string, callback: (requestId: string, lease: DispatcherLeaseRef) => void): void {
    this.callbacks.set(service, callback);
  }

  cancel(requestId: string): void {
    this.cancelled.push(requestId);
    const at = this.waiting.findIndex(request => request.id === requestId);
    if (at >= 0) this.waiting.splice(at, 1);
  }

  private lease(service: string, pool: string, resume?: string): DispatcherLeaseRef {
    const id = `lease_${++this.nextLease}`;
    this.granted.set(id, service);
    return { id, pool, state: resume ? 'active' : 'preparing', ...(resume ? { sessionId: resume } : {}) };
  }

  /** A slot opened: the waiting places walk in, in the order they asked. */
  private drain(): void {
    while (this.waiting.length > 0 && this.held < this.capacity) {
      const request = this.waiting.shift()!;
      this.held++;
      const lease = this.lease(request.service, request.pool, request.resume);
      this.callbacks.get(request.service)?.(request.id, lease);
    }
  }
}
