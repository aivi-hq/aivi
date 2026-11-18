/** A boundary a test can wait on: `next()` resolves with the arguments of
 *  the next call nobody has read yet — one already made, or the one still to
 *  come. Tests wait for the operation itself to arrive there; no ticks are
 *  guessed and nothing is polled. */
export function boundary<A extends unknown[] = []>() {
  const unread: A[] = [];
  const readers: Array<(args: A) => void> = [];
  const reach = (...args: A): void => {
    const read = readers.shift();
    if (read) read(args);
    else unread.push(args);
  };
  const next = (): Promise<A> => {
    const args = unread.shift();
    return args ? Promise.resolve(args) : new Promise(resolve => readers.push(resolve));
  };
  return { reach, next };
}
