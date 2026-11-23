/**
 * Everything in this file runs inside the Meet page, not in Node. `meeting.ts`
 * sends the source text of one of these functions through `tab.call` or
 * `tab.waitFor`, so a function here closes over nothing: no import, no
 * constant of this module, no other function of this file. Data goes in as
 * arguments, and only plain values come back.
 */

/** What the screen shows, in ONE look: the address, the words, and every
 *  button's name with whether it can take a click. The state machine
 *  decides over this plain data; the locators are for acting. */
export interface Screen {
  url: string;
  words: string;
  buttons: Array<{ name: string; enabled: boolean }>;
}

export const lookAtScreen = (): Screen => {
  const words = document.body ? document.body.innerText || document.body.textContent || '' : '';
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(el => ({
    name: (el.getAttribute('aria-label') || el.textContent || '').trim(),
    enabled: !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
  }));
  return { url: location.href, words, buttons };
};

export const titleOfPage = (): string => document.title;

/** True when no enabled button says leave: the page took the hang-up. */
export const leaveGone = () =>
  !Array.from(document.querySelectorAll('button, [role="button"]')).some(
    el =>
      /leave call|leave meeting|hang up/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()) &&
      !(el as HTMLButtonElement).disabled,
  );

/** True when the first mute button says `value` about itself. */
export const muteSays = (value: string) => {
  const el = document.querySelector('button[data-is-muted]');
  return el !== null && el.getAttribute('data-is-muted') === value;
};
