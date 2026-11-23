import type { TestContext } from 'node:test';

/** Replace one property of an object for one test, and put back what was there. */
export function override(t: TestContext, target: object, key: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  t.after(() => {
    if (previous) Object.defineProperty(target, key, previous);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** Set (or, with undefined, remove) one environment variable for one test. */
export function setEnv(t: TestContext, key: string, value: string | undefined): void {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}
