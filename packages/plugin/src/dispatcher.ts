/** The dispatcher contract: capacity as named pools. The dispatcher is the
 *  host's capacity system — every pool is an endpoint (capacity, an optional
 *  model, an optional fallback), and every service that works asks it for a
 *  slot before working. Ticket work drew it first; voice rooms draw the same
 *  pools, so a local box and a remote endpoint are pools like any other.
 *
 *  This is the narrow view a room holder needs (the host's `Dispatcher`
 *  satisfies it): ask, be provided a session, work, release. The queue is
 *  the dispatcher's memory, not yours: a full pool answers `queued` with an
 *  id, and the callback you registered hears when that request lands as a
 *  lease. No timers, no polling — capacity moves, you are told.
 */

export interface DispatcherLeaseRef {
  id: string;
  /** The pool whose slot this holds; a session keeps the pool it was born in. */
  pool: string;
  /** `preparing` means the session is not attached yet: `provide` it. */
  state: 'preparing' | 'active' | 'expiring';
  sessionId?: string;
}

export type DispatcherGrant =
  | { lease: DispatcherLeaseRef }
  /** The pool is full and took the request: the callback hears when it lands. */
  | { queued: string }
  /** `waiting`: the service already holds the pool's one queue place. */
  | { refused: 'full' | 'pool-gone' | 'waiting'; pool: string };

export interface Dispatcher {
  /** Ask for a slot in a pool (absent: the `default` pool). A resume returns
   *  to the pool its session was created in — that is what keeps a room's
   *  conversation on the endpoint that made it. */
  request(input: { service: string; pool?: string; resume?: string }): DispatcherGrant;
  /** Provide a preparing lease with its session: created with the pool's
   *  model, or resumed with whatever it was born with. `create` says the
   *  named session does not exist yet: make it real under that id, with the
   *  pool's model — a caller that pre-allocates ids keeps them. `title` and
   *  `metadata` ride the create: the aivi origin that dreaming reviews and
   *  the name OpenCode's list shows are set where the session is born. */
  provide(
    leaseId: string,
    work: {
      agent: string;
      directory: string;
      sessionId?: string;
      create?: boolean;
      title?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<DispatcherLeaseRef>;
  /** End the lease and open its slot to the queue. `pending` means the slot
   *  stays held until a kill is confirmed — the dispatcher keeps watching. */
  release(leaseId: string): Promise<{ ended: DispatcherLeaseRef } | { pending: DispatcherLeaseRef }>;
  /** Hear when one of this service's queued requests becomes a lease. */
  registerCallback(service: string, callback: (requestId: string, lease: DispatcherLeaseRef) => void): void;
  /** Lose a queue place and nothing more. */
  cancel(requestId: string): void;
}
