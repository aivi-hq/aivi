import type { TestContext } from 'node:test';

const saved = new WeakMap<TestContext, Map<string, PropertyDescriptor | undefined>>();

/** Set globals for one test, the way a browser page has them, and put things
 *  back after it. Give each test only what the function under test reads. */
export function inPage(t: TestContext, globals: Record<string, unknown>): void {
  let originals = saved.get(t);
  if (originals === undefined) {
    const mine = new Map<string, PropertyDescriptor | undefined>();
    originals = mine;
    saved.set(t, mine);
    t.after(() => {
      for (const [name, original] of mine) {
        if (original === undefined) delete (globalThis as Record<string, unknown>)[name];
        else Object.defineProperty(globalThis, name, original);
      }
    });
  }
  for (const [name, value] of Object.entries(globals)) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

export interface ElementOptions {
  tag?: string;
  text?: string;
  disabled?: boolean;
  attributes?: Record<string, string>;
}

/** An element as a page function reads it: the members it touches, no more. */
export function element(
  t: TestContext,
  { tag = 'BUTTON', text = '', disabled = false, attributes = {} }: ElementOptions = {},
) {
  return {
    tagName: tag,
    textContent: text,
    disabled,
    getAttribute: (name: string) => attributes[name] ?? null,
    click: t.mock.fn(),
  };
}
