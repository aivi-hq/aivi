/** The functions that run inside the browser page. Their one collaborator is
 *  the page, so each test sets `document` (and what else the function reads)
 *  to an object literal with only the members that function touches. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  clickLocated,
  fillLocated,
  hasSelector,
  hasText,
  locate,
  readAttribute,
  readText,
  readUserAgent,
  readWords,
} from '../src/page.ts';

/** Set globals for one test, and put things back after it. */
const saved = new WeakMap<TestContext, Map<string, PropertyDescriptor | undefined>>();

function inPage(t: TestContext, globals: Record<string, unknown>): void {
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

interface ElementOptions {
  tag?: string;
  text?: string;
  disabled?: boolean;
  attributes?: Record<string, string>;
}

function element(
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

/** What `HTMLInputElement` is for `fillLocated`: a `value` with a setter on the prototype. */
class StubInput extends EventTarget {
  #value = '';
  readonly #attributes: Record<string, string>;
  textContent = '';

  constructor(attributes: Record<string, string> = {}) {
    super();
    this.#attributes = attributes;
  }

  get value(): string {
    return this.#value;
  }

  set value(next: string) {
    this.#value = next;
  }

  getAttribute(name: string): string | null {
    return this.#attributes[name] ?? null;
  }
}

const BUTTONS = 'button, [role="button"]';

test('locate by CSS answers the words, the state and, when asked, an attribute of the first match', t => {
  const join = element(t, { text: '  Join now ', attributes: { 'data-x': 'y' } });
  const querySelector = t.mock.fn(() => join);
  inPage(t, { document: { querySelector } });

  assert.deepEqual(locate('css', '#join', ''), { label: 'Join now', enabled: true, attr: undefined });
  assert.deepEqual(locate('css', '#join', 'data-x'), { label: 'Join now', enabled: true, attr: 'y' });
  assert.deepEqual(locate('css', '#join', 'data-z'), { label: 'Join now', enabled: true, attr: undefined });
  assert.deepEqual(
    querySelector.mock.calls.map(call => call.arguments),
    [['#join'], ['#join'], ['#join']],
  );
});

test('locate answers null when nothing matches', t => {
  inPage(t, { document: { querySelector: () => null, querySelectorAll: () => [] } });

  assert.equal(locate('css', '#join', ''), null);
  assert.equal(locate('name', 'join', ''), null);
});

test('locate by name looks at the buttons, as a case-insensitive regex on the aria-label first, then the text', t => {
  const buttons = [
    element(t, { text: 'Cancel' }),
    element(t, { text: 'Ask', attributes: { 'aria-label': 'Ask to JOIN' } }),
    element(t, { text: 'Ask to join now' }),
  ];
  const querySelectorAll = t.mock.fn(() => buttons);
  inPage(t, { document: { querySelectorAll } });

  assert.deepEqual(locate('name', 'ask to join', ''), { label: 'Ask to JOIN', enabled: true, attr: undefined });
  assert.deepEqual(locate('name', '^ask to join now$', ''), {
    label: 'Ask to join now',
    enabled: true,
    attr: undefined,
  });
  assert.deepEqual(locate('name', 'nothing like it', ''), null);
  assert.deepEqual(querySelectorAll.mock.calls[0]?.arguments, [BUTTONS]);
});

test('locate names an element without words by its tag', t => {
  inPage(t, { document: { querySelector: () => element(t, { tag: 'DIV' }) } });

  assert.deepEqual(locate('css', 'div', ''), { label: 'div', enabled: true, attr: undefined });
});

test('an element is not enabled when it is disabled or says aria-disabled', t => {
  for (const [state, enabled] of [
    [{ disabled: true }, false],
    [{ attributes: { 'aria-disabled': 'true' } }, false],
    [{ attributes: { 'aria-disabled': 'false' } }, true],
  ] as const) {
    inPage(t, { document: { querySelector: () => element(t, { text: 'Join', ...state }) } });

    assert.equal(locate('css', '#join', '')?.enabled, enabled, JSON.stringify(state));
  }
});

test('clickLocated by CSS clicks an enabled match once and answers its words', t => {
  const join = element(t, { text: 'Join now' });
  inPage(t, { document: { querySelector: () => join } });

  assert.equal(clickLocated('css', '#join'), 'Join now');

  assert.equal(join.click.mock.callCount(), 1);
});

test('clickLocated clicks nothing that is disabled or absent', t => {
  const join = element(t, { text: 'Join now', disabled: true });
  inPage(t, { document: { querySelector: () => join } });
  assert.equal(clickLocated('css', '#join'), null);
  inPage(t, { document: { querySelector: () => null } });
  assert.equal(clickLocated('css', '#join'), null);

  assert.equal(join.click.mock.callCount(), 0);
});

test('clickLocated by name skips a disabled match and clicks the first enabled one', t => {
  const disabled = element(t, { text: 'Join', disabled: true });
  const other = element(t, { text: 'Cancel' });
  const enabled = element(t, { text: 'Join', attributes: { 'aria-label': 'Join the call' } });
  const querySelectorAll = t.mock.fn(() => [disabled, other, enabled]);
  inPage(t, { document: { querySelectorAll } });

  assert.equal(clickLocated('name', 'join'), 'Join the call');

  assert.deepEqual(
    [disabled, other, enabled].map(button => button.click.mock.callCount()),
    [0, 0, 1],
  );
  assert.deepEqual(querySelectorAll.mock.calls[0]?.arguments, [BUTTONS]);
});

test('clickLocated by name answers null when no match is enabled', t => {
  inPage(t, { document: { querySelectorAll: () => [element(t, { text: 'Join', disabled: true })] } });

  assert.equal(clickLocated('name', 'join'), null);
});

test('clickLocated names a click on an element without words by its tag', t => {
  inPage(t, { document: { querySelector: () => element(t, { tag: 'A' }) } });

  assert.equal(clickLocated('css', 'a'), 'a');
});

test('fillLocated sets the value through the native setter, then tells the page with an input event', t => {
  const input = new StubInput();
  const frameworkWrites: string[] = [];
  // a framework that tracks a plain `.value =` has its own setter on the element
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => 'what the framework thinks',
    set: (next: string) => frameworkWrites.push(next),
  });
  const events: Array<[string, boolean]> = [];
  input.addEventListener('input', event => events.push([event.type, event.bubbles]));
  inPage(t, { document: { querySelector: () => input }, HTMLInputElement: StubInput });

  assert.equal(fillLocated('css', '#name', 'aivi'), 'filled');

  assert.deepEqual(frameworkWrites, [], 'the framework setter was not used');
  assert.equal(Object.getOwnPropertyDescriptor(StubInput.prototype, 'value')?.get?.call(input), 'aivi');
  assert.deepEqual(events, [['input', true]]);
});

test('fillLocated answers absent for nothing, and not-an-input for something else', t => {
  inPage(t, { HTMLInputElement: StubInput, document: { querySelector: () => null } });
  assert.equal(fillLocated('css', '#name', 'aivi'), 'absent');

  inPage(t, { document: { querySelector: () => element(t, { text: 'Join' }) } });
  assert.equal(fillLocated('css', '#join', 'aivi'), 'not-an-input');
});

test('fillLocated answers not-an-input when the page has no native setter to use', t => {
  class NoValue extends EventTarget {}
  inPage(t, { HTMLInputElement: NoValue, document: { querySelector: () => new NoValue() } });

  assert.equal(fillLocated('css', '#name', 'aivi'), 'not-an-input');
});

test('fillLocated by name finds the button-like element by its words', t => {
  const input = new StubInput({ role: 'button', 'aria-label': 'Your name' });
  const querySelectorAll = t.mock.fn(() => [element(t), element(t, { text: 'Cancel' }), input]);
  inPage(t, { document: { querySelectorAll }, HTMLInputElement: StubInput });

  assert.equal(fillLocated('name', 'your name', 'aivi'), 'filled');
  assert.equal(fillLocated('name', 'cancel', 'aivi'), 'not-an-input');
  assert.equal(fillLocated('name', 'nothing like it', 'aivi'), 'absent');

  assert.deepEqual(querySelectorAll.mock.calls[0]?.arguments, [BUTTONS]);
});

test('readWords reads the text of the body, its textContent when there is no innerText, and nothing without a body', t => {
  for (const [body, words] of [
    [{ innerText: 'Ask to join', textContent: 'Ask to join (hidden)' }, 'Ask to join'],
    [{ innerText: '', textContent: 'only content' }, 'only content'],
    [{ innerText: '', textContent: '' }, ''],
    [null, ''],
  ] as const) {
    inPage(t, { document: { body } });

    assert.equal(readWords(), words);
  }
});

test('readText reads the visible text of the first match, and nothing without one', t => {
  const querySelector = t.mock.fn((selector: string) => (selector === '#join' ? { innerText: 'Join now' } : null));
  inPage(t, { document: { querySelector } });

  assert.equal(readText('#join'), 'Join now');
  assert.equal(readText('#gone'), undefined);
});

test('readAttribute reads one attribute of the first match, and nothing when either is missing', t => {
  const querySelector = t.mock.fn((selector: string) =>
    selector === 'a' ? { getAttribute: (name: string) => (name === 'href' ? '/join' : null) } : null,
  );
  inPage(t, { document: { querySelector } });

  assert.equal(readAttribute('a', 'href'), '/join');
  assert.equal(readAttribute('a', 'target'), undefined);
  assert.equal(readAttribute('nav', 'href'), undefined);
});

test('hasSelector says whether anything matches', t => {
  inPage(t, { document: { querySelector: (selector: string) => (selector === '#join' ? {} : null) } });

  assert.equal(hasSelector('#join'), true);
  assert.equal(hasSelector('#gone'), false);
});

test('hasText says whether the page contains the words, and has none without a body', t => {
  inPage(t, { document: { body: { innerText: 'Ready to join?' } } });
  assert.equal(hasText('join'), true);
  assert.equal(hasText('leave'), false);

  inPage(t, { document: { body: null } });
  assert.equal(hasText('join'), false);
});

test('readUserAgent reads what the page says about itself', t => {
  inPage(t, { navigator: { userAgent: 'HeadlessChrome/141.0.0.0' } });

  assert.equal(readUserAgent(), 'HeadlessChrome/141.0.0.0');
});
