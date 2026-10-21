/**
 * One tab, addressed by the session id the browser handed us.
 *
 * The helpers are the everyday verbs — read, wait, click, type — and every
 * one of them is the same trick: a small function, sent as source text and
 * run inside the page by `Runtime.evaluate`, whose return value comes back
 * as a plain value. A page function must not close over anything from this
 * file; data goes in as arguments, and only plain values come back. That
 * is why the locators below carry their matcher as an argument and their
 * finder as a self-contained function, not as shared code.
 *
 * Waiting is the package's job, never the caller's. `tab.locator(matcher)`
 * hands back a handle whose verbs wait for the page to be ready for them:
 * `click()` does not fire until the element exists AND is enabled, the way
 * playwright's actionability works
 * (https://playwright.dev/docs/actionability). A framework keeps its own
 * submit buttons disabled until it has accepted what was typed — so the
 * wait for enabled is the verification that the page will listen, and no
 * caller ever clicks in a loop hoping one lands.
 *
 * Whatever the helpers do not cover is one `send` away: the full protocol
 * stays reachable per tab, because the face trick itself — installing a
 * script before the page's own scripts run — is exactly such a raw call.
 */
import type { CdpConnection, CdpEvent } from './connection.ts';
import { sleep } from './connection.ts';

/** A function that runs inside the page. It travels as source text, so it
 *  closes over nothing from here. */
export type PageFunction<T = unknown> = (...args: never[]) => T;

export interface WaitOptions {
  /** Give up after this many milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Pause between looks. Default 120. */
  intervalMs?: number;
}

interface EvalAnswer {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_INTERVAL_MS = 120;

function unwrap<T>(answer: EvalAnswer): T {
  const details = answer.exceptionDetails;
  if (details !== undefined) {
    throw new Error(details.exception?.description ?? details.text ?? 'the page function threw');
  }
  return answer.result?.value as T;
}

function labelOf(condition: PageFunction | string): string {
  const source = typeof condition === 'string' ? condition : condition.toString();
  return source.length > 120 ? `${source.slice(0, 120)}…` : source;
}

/** The package's one way to wait: look, and if not yet, look again after a
 *  pause. CDP announces "the page loaded", never "this element finally
 *  exists", so bounded re-looking is the honest mechanism. */
async function poll(look: () => Promise<boolean>, what: string, options: WaitOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  do {
    if (await look()) return;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  throw new Error(`no ${what} within ${timeoutMs} ms`);
}

/** One page-side look: the first element the matcher describes. `name:`
 *  matches a button's accessible name — `aria-label` first, then its text,
 *  what real apps like Meet put on their buttons — as a case-insensitive
 *  regex; anything else is a CSS selector. Answers the element's own words,
 *  whether it can take a click, and (when asked for) one attribute. */
const locate = (
  kind: string,
  matcher: string,
  attribute: string,
): { label: string; enabled: boolean; attr: string | undefined } | null => {
  const words = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  const live = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
  let el: Element | undefined;
  if (kind === 'name') {
    const rx = new RegExp(matcher, 'i');
    el = Array.from(document.querySelectorAll('button, [role="button"]')).find(e => rx.test(words(e)));
  } else {
    el = document.querySelector(matcher) ?? undefined;
  }
  if (el === undefined) return null;
  return {
    label: words(el) || el.tagName.toLowerCase(),
    enabled: live(el),
    attr: attribute === '' ? undefined : (el.getAttribute(attribute) ?? undefined),
  };
};

/** Find the first element the matcher describes that is ENABLED, and click
 *  it — one page-side move, no window between looking and touching where
 *  the element could change its mind. Null when there was nothing to click
 *  (absent, or there but disabled). */
const clickLocated = (kind: string, matcher: string): string | null => {
  const words = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  const live = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
  let el: Element | undefined;
  if (kind === 'name') {
    const rx = new RegExp(matcher, 'i');
    el = Array.from(document.querySelectorAll('button, [role="button"]')).find(e => rx.test(words(e)) && live(e));
  } else {
    const found = document.querySelector(matcher);
    if (found !== null && live(found)) el = found;
  }
  if (el === undefined) return null;
  (el as HTMLElement).click();
  return words(el) || el.tagName.toLowerCase();
};

/** Type into a box the way its framework expects: set the value through the
 *  native setter, then dispatch `input`. A plain `.value =` leaves
 *  frameworks like Meet's convinced the box is still empty — proven on the
 *  real waiting-room name box. */
const fillLocated = (kind: string, matcher: string, value: string): 'filled' | 'absent' | 'not-an-input' => {
  const el: Element | null | undefined =
    kind === 'name'
      ? Array.from(document.querySelectorAll('button, [role="button"]')).find(e =>
          new RegExp(matcher, 'i').test((e.getAttribute('aria-label') || e.textContent || '').trim()),
        )
      : document.querySelector(matcher);
  if (el === null || el === undefined) return 'absent';
  if (!(el instanceof HTMLInputElement)) return 'not-an-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) return 'not-an-input';
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'filled';
};

/** A waiting handle on an element, in the shape playwright made popular:
 *  get it once from `tab.locator(matcher)`, and every verb on it waits
 *  for the page to be ready instead of the caller guessing in a loop. */
export interface Locator {
  /** The matcher it was built from, for logs and errors. */
  readonly matcher: string;
  /** There right now — disabled counts. No waiting. */
  exists(): Promise<boolean>;
  /** There right now AND able to take a click. No waiting. */
  enabled(): Promise<boolean>;
  /** One attribute's value, right now; undefined when the element or the
   *  attribute is absent. The page's own state often lives in attributes
   *  (`data-is-muted` on Meet's mic button) where names cannot see it. */
  attr(name: string): Promise<string | undefined>;
  /** Wait until it is there. */
  waitFor(options?: WaitOptions): Promise<void>;
  /** Wait until it is there and enabled, then click it ONCE, and answer
   *  the words it carries (aria-label, text, or tag). A framework keeps
   *  its submit buttons disabled until it accepts what was typed, so this
   *  wait is the proof the page will listen — the old failure was clicking
   *  a still-hydrating screen, reporting success, and then waiting on a
   *  human for an action the page never received (real Meet, 2026-10-14). */
  click(options?: WaitOptions): Promise<string>;
  /** Wait until it is there, then type into it the way its framework
   *  expects. */
  fill(value: string, options?: WaitOptions): Promise<void>;
}

class LocatorHandle implements Locator {
  readonly #tab: Tab;
  readonly matcher: string;
  readonly #kind: 'css' | 'name';
  readonly #body: string;

  constructor(tab: Tab, matcher: string) {
    this.#tab = tab;
    this.matcher = matcher;
    this.#kind = matcher.startsWith('name:') ? 'name' : 'css';
    this.#body = this.#kind === 'name' ? matcher.slice('name:'.length) : matcher;
  }

  async #probe(attribute = ''): Promise<{ label: string; enabled: boolean; attr: string | undefined } | null> {
    return this.#tab.call(locate, this.#kind, this.#body, attribute);
  }

  async exists(): Promise<boolean> {
    return (await this.#probe()) !== null;
  }

  async enabled(): Promise<boolean> {
    return (await this.#probe())?.enabled === true;
  }

  async attr(name: string): Promise<string | undefined> {
    return (await this.#probe(name))?.attr;
  }

  async waitFor(options: WaitOptions = {}): Promise<void> {
    await poll(async () => (await this.#probe()) !== null, `element ${this.matcher}`, options);
  }

  async click(options: WaitOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    do {
      const hit = await this.#tab.call<string | null>(clickLocated, this.#kind, this.#body);
      if (hit !== null) return hit;
      await sleep(intervalMs);
    } while (Date.now() < deadline);
    const seen = await this.#probe();
    throw new Error(
      seen === null
        ? `no element matching ${this.matcher} within ${timeoutMs} ms`
        : `${this.matcher} stayed disabled for ${timeoutMs} ms — the page never took it`,
    );
  }

  async fill(value: string, options: WaitOptions = {}): Promise<void> {
    await this.waitFor(options);
    const answer = await this.#tab.call(fillLocated, this.#kind, this.#body, value);
    if (answer === 'absent') throw new Error(`${this.matcher} vanished before the fill`);
    if (answer === 'not-an-input') throw new Error(`cannot fill ${this.matcher}: it is not an <input>`);
  }
}

export class Tab {
  readonly #connection: CdpConnection;
  readonly #targetId: string;
  readonly #sessionId: string;
  readonly #listeners = new Map<(event: CdpEvent) => void, EventListener>();
  #pageEnabled = false;

  constructor(connection: CdpConnection, targetId: string, sessionId: string) {
    this.#connection = connection;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
  }

  get targetId(): string {
    return this.#targetId;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** The escape hatch: any protocol command, addressed to this tab. */
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    return this.#connection.send<T>(method, params, this.#sessionId);
  }

  /** Listen for a protocol event of this tab. The listener sees only events
   *  carrying our session id. */
  on(event: string, listener: (event: CdpEvent) => void): this {
    const wrapper: EventListener = raw => {
      const event = raw as CdpEvent;
      if (event.sessionId === this.#sessionId) listener(event);
    };
    this.#listeners.set(listener, wrapper);
    this.#connection.addEventListener(event, wrapper);
    return this;
  }

  off(event: string, listener: (event: CdpEvent) => void): this {
    const wrapper = this.#listeners.get(listener);
    if (wrapper !== undefined) {
      this.#connection.removeEventListener(event, wrapper);
      this.#listeners.delete(listener);
    }
    return this;
  }

  #once(event: string, timeoutMs: number): Promise<CdpEvent> {
    return new Promise<CdpEvent>((resolve, reject) => {
      const listener = (arrived: CdpEvent): void => {
        this.off(event, listener);
        clearTimeout(timer);
        resolve(arrived);
      };
      const timer = setTimeout(() => {
        this.off(event, listener);
        reject(new Error(`no ${event} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.on(event, listener);
    });
  }

  /** Navigate and wait for the load event. Blank on arrival is normal for a
   *  fresh tab: the caller installs its scripts first, then drives here. */
  async goto(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!this.#pageEnabled) {
      await this.send('Page.enable');
      this.#pageEnabled = true;
    }
    const loaded = this.#once('Page.loadEventFired', timeoutMs);
    const answer = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (answer.errorText !== undefined) {
      throw new Error(`navigation to ${url} failed: ${answer.errorText}`);
    }
    await loaded;
  }

  /** Run an expression in the page and take its value back. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return unwrap<T>(
      await this.send<EvalAnswer>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    );
  }

  /** Run a function in the page and take its value back. A string is sent as
   *  source, for text that was built elsewhere. Arguments travel as JSON —
   *  the same rule as return values, so a page function truly cannot close
   *  over anything or carry anything but plain data. `Runtime.evaluate` in a
   *  wrapped expression is used instead of `callFunctionOn` because it works
   *  from the first breath of a fresh tab, before any execution context is
   *  announced. */
  async call<T = unknown>(fn: PageFunction<T> | string, ...args: unknown[]): Promise<T> {
    const source = typeof fn === 'string' ? fn : fn.toString();
    const given = args.map(value => JSON.stringify(value) ?? 'undefined');
    return unwrap<T>(
      await this.send<EvalAnswer>('Runtime.evaluate', {
        expression: `(${source})(${given.join(', ')})`,
        awaitPromise: true,
        returnByValue: true,
      }),
    );
  }

  /** Poll until the condition answers truthy, and take that answer. CDP
   *  reports "the page loaded", never "this element finally exists", so
   *  polling is the honest mechanism — bounded, one-shot sleeps. Extra
   *  arguments travel to the page function as plain JSON, the same rule
   *  as `call`. */
  async waitFor<T>(
    condition: PageFunction<T> | string,
    options: WaitOptions = {},
    ...args: unknown[]
  ): Promise<NonNullable<T>> {
    return this.#wait(condition, args, options);
  }

  async waitForSelector(selector: string, options: WaitOptions = {}): Promise<void> {
    await this.#wait((sel: string) => document.querySelector(sel) !== null, [selector], options);
  }

  async waitForText(needle: string, options: WaitOptions = {}): Promise<void> {
    await this.#wait((text: string) => (document.body?.innerText ?? '').includes(text), [needle], options);
  }

  async #wait<T>(condition: PageFunction<T> | string, args: unknown[], options: WaitOptions): Promise<NonNullable<T>> {
    let answer: T | undefined;
    await poll(
      async () => {
        answer = await this.call(condition, ...args);
        return Boolean(answer);
      },
      labelOf(condition),
      options,
    );
    return answer as NonNullable<T>;
  }

  /** A waiting handle on the first element the matcher describes: a CSS
   *  selector, or `name:` followed by a case-insensitive regex the
   *  accessible name of a button must match (`aria-label` first, then its
   *  text). Buttons that live behind accessible names and inputs addressed
   *  by CSS hand back the same kind of handle, and every verb on it waits
   *  before it acts. */
  locator(matcher: string): Locator {
    return new LocatorHandle(this, matcher);
  }

  /** Whether anything matches, right now. */
  async exists(matcher: string): Promise<boolean> {
    return this.locator(matcher).exists();
  }

  /** The words on the page, as a person reads them. */
  async words(): Promise<string> {
    return this.call((): string => {
      const body = document.body;
      return body === null ? '' : body.innerText || body.textContent || '';
    });
  }

  /** Wait until the element is there and enabled, click it once, answer
   *  its words. For more than one verb on the same element, keep the
   *  handle: `tab.locator(matcher)`. */
  click(matcher: string, options: WaitOptions = {}): Promise<string> {
    return this.locator(matcher).click(options);
  }

  /** Type into a box the way its framework expects, after waiting for it
   *  to be there. */
  async fill(matcher: string, value: string, options: WaitOptions = {}): Promise<void> {
    await this.locator(matcher).fill(value, options);
  }

  /** The visible text of the first match, or undefined when there is none. */
  async text(selector: string): Promise<string | undefined> {
    return this.call((sel: string) => {
      const el = document.querySelector(sel);
      return el === null ? undefined : (el as HTMLElement).innerText;
    }, selector);
  }

  async attr(selector: string, name: string): Promise<string | undefined> {
    return this.call(
      (sel: string, attribute: string) => document.querySelector(sel)?.getAttribute(attribute) ?? undefined,
      selector,
      name,
    );
  }

  async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  /** Make the page unable to tell headless from headed: `HeadlessChrome/`
   *  in the user agent is a fingerprint conferencing apps read. The launch
   *  flag keeps `navigator.webdriver` false NATIVELY — patching it with a
   *  script is itself the tell (measured 2026-10-14: a defineProperty
   *  getter on Navigator.prototype alone got us refused by Meet; the page
   *  inspects the getter's source). The override carries the browser's
   *  own client-hint metadata from `Browser.getVersion`, so the story the
   *  page reads is self-consistent and none of it is invented. Answers
   *  false when there was nothing to hide. */
  async hideHeadless(): Promise<boolean> {
    const ua = await this.call((): string => navigator.userAgent);
    if (!ua.includes('HeadlessChrome/')) return false;
    const { userAgentMetadata } = (await this.send('Browser.getVersion')) as {
      userAgentMetadata?: Record<string, unknown>;
    };
    await this.send('Network.setUserAgentOverride', {
      userAgent: ua.replace('HeadlessChrome/', 'Chrome/'),
      ...(userAgentMetadata === undefined ? {} : { userAgentMetadata }),
    });
    return true;
  }

  /** Close the tab. The browser itself outlives it, so another tab can open
   *  in a moment. */
  async close(): Promise<void> {
    await this.#connection.send('Target.closeTarget', { targetId: this.#targetId });
  }
}
