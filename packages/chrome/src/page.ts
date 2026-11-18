/**
 * Everything in this file runs inside the browser page, not in Node. `tab.ts`
 * sends the source text of one of these functions through `Runtime.evaluate`
 * and takes the value back, so a function here closes over nothing: no
 * import, no constant of this module, no other function of this file. Data
 * goes in as arguments, and only plain values come back. That is also why
 * `locate`, `clickLocated` and `fillLocated` each carry their own copy of the
 * matching code instead of sharing it.
 */

/** One page-side look: the first element the matcher describes. `name:`
 *  matches a button's accessible name — `aria-label` first, then its text,
 *  what real apps like Meet put on their buttons — as a case-insensitive
 *  regex; anything else is a CSS selector. Answers the element's own words,
 *  whether it can take a click, and (when asked for) one attribute. */
export const locate = (
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
export const clickLocated = (kind: string, matcher: string): string | null => {
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
export const fillLocated = (kind: string, matcher: string, value: string): 'filled' | 'absent' | 'not-an-input' => {
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

/** The words on the page, as a person reads them. */
export const readWords = (): string => {
  const body = document.body;
  return body === null ? '' : body.innerText || body.textContent || '';
};

/** The visible text of the first match, or undefined when there is none. */
export const readText = (sel: string) => {
  const el = document.querySelector(sel);
  return el === null ? undefined : (el as HTMLElement).innerText;
};

/** One attribute of the first match, or undefined when either is absent. */
export const readAttribute = (sel: string, attribute: string) =>
  document.querySelector(sel)?.getAttribute(attribute) ?? undefined;

/** Whether anything matches the CSS selector. */
export const hasSelector = (sel: string) => document.querySelector(sel) !== null;

/** Whether the page's text contains the words. */
export const hasText = (text: string) => (document.body?.innerText ?? '').includes(text);

/** The user agent the page reads about itself. */
export const readUserAgent = (): string => navigator.userAgent;
