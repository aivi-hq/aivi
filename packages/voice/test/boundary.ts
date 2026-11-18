import { EventEmitter, on } from 'node:events';

/** A boundary a test can wait on: `next()` resolves with the arguments of
 *  the next call nobody has read yet — one already made, or the one still to
 *  come. Tests wait for the operation itself to arrive there; no ticks are
 *  guessed and nothing is polled. */
export function boundary<A extends unknown[] = []>() {
  const calls = new EventEmitter();
  // Every call from now on, kept in order until a test reads it.
  const reached = on(calls, 'reach');
  return {
    reach: (...args: A): void => {
      calls.emit('reach', ...args);
    },
    next: async (): Promise<A> => (await reached.next()).value as A,
  };
}
