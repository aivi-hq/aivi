/** The Meet buttons, pressed in order. The waiting is not here — it lives
 *  in `@aivi/chrome`'s locators: `click()` acts only once the button
 *  exists AND is enabled, and a framework keeps "Ask to join" disabled
 *  until it has accepted the name typed, so the wait is the verification
 *  (the old failure was clicking a still-hydrating screen and then waiting
 *  on the host for a request Meet never received — 2026-10-14). What is
 *  left here is what the screens are and what to do on each. The route was
 *  proven on a real meeting (2026-10-13: waiting room, typed name, host
 *  admitted, the face showed on a phone across the house).
 *
 *  A wait that sits blind is a bug even when it eventually works: every
 *  wait here says what the page actually shows while it waits, so a stuck
 *  one reads as evidence instead of as 15 silent minutes (learned the hard
 *  way 2026-10-14: the operator stood admitted in a real call, hearing the
 *  raw page audio, while the admission wait below saw nothing and said
 *  nothing — and nothing after it could start: no ears, no session). */
import { sleep, type Tab } from '@aivi/chrome';

export type MeetLog = (msg: string, extra?: Record<string, unknown>) => void;

export interface JoinOptions {
  /** What to type at the waiting room. */
  name: string;
  log: MeetLog;
  /** Pre-join screens must resolve into the call or the ask within this. */
  joinTimeoutMs?: number;
  /** The host's admission window once we asked. */
  askTimeoutMs?: number;
  /** Called after every step with its label (`opened`, `dismissed`,
   *  `mic-live`, `clicked`, `asked`, `waiting`, `in-call`). For eyes: a
   *  trace script takes a screenshot per step; production passes nothing. */
  onStep?: (label: string) => Promise<void>;
}

export interface Joined {
  /** True when the waiting room (name box, host admission) was on the way. */
  viaWaitingRoom: boolean;
}

/** What the screen shows, in ONE look: the address, the words, and every
 *  button's name with whether it can take a click. The state machine
 *  decides over this plain data; the locators below are for acting. */
interface Screen {
  url: string;
  words: string;
  buttons: Array<{ name: string; enabled: boolean }>;
}

const readScreen = (tab: Tab): Promise<Screen> =>
  tab.call((): Screen => {
    const words = document.body ? document.body.innerText || document.body.textContent || '' : '';
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).map(el => ({
      name: (el.getAttribute('aria-label') || el.textContent || '').trim(),
      enabled: !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
    }));
    return { url: location.href, words, buttons };
  });

const inCallOn = (screen: Screen): boolean =>
  screen.buttons.some(b => LEAVE.test(b.name) && b.enabled) && !LOBBY.test(screen.words);

const DIALOG = 'name:^(not now|no thanks|later|skip|got it|ok|keep calling)$';
// The mute buttons as the REAL page carries them (the operator's devtools
// route, 2026-10-14): `button[data-is-muted]`, mic first, cam second. The
// attribute is the state, and it is the state Meet transmits by: a muted
// guest is silence no matter what the shim's track carries. aivi's mic is
// its own synthetic voice — it joins LIVE.
const MUTE_BUTTON = 'button[data-is-muted]';
// the real waiting-room box (screenshot, 2026-10-14): a placeholder, no
// aria-label — match both shapes
const NAME_BOX = 'input[aria-label="Your name"], input[aria-label="full name"], input[placeholder="Your name"]';
const ASK = 'name:^(ask to join|join now|join|join in)$';
// NOT anchored — on purpose, until the page is caught on the log saying
// its real label. The anchored version sat on a real in-call page for
// three minutes (2026-10-14, `meet.still-waiting` will name it) while the
// substring one resolved the same screen in 21 s. One run of true names
// from the debug line, and the anchor comes back.
const LEAVE = /leave call|leave meeting|hang up/i;
// The lobby's own words (verified 2026-10-14, screenshot: "Please wait
// until a meeting host brings you into the call"). Only these: "Waiting
// for others to join" also shows INSIDE an open call, and a predicate
// matching it would wait for a host who does not exist. And the lobby
// carries its own hang-up button, so a leave button alone is not "in
// call" — the waiting words must be gone too.
const LOBBY = /please wait until/i;
const SIGNIN_WALL = /accounts\.google\.com|ServiceLogin|signin/i;
// the screen Meet shows when the meeting's access settings refuse a guest
// (verified on a real meeting 2026-10-14: "You can't join this video
// call", with a countdown back to the home screen). The refusal is also
// what Meet flashes when "Ask to join" is clicked before its page has
// settled: two joins threw on first sight of this screen while the very
// next attempt joined (2026-10-14). So a refusal is a SCREEN, not a
// verdict: click its "Try again" and keep reading; only the join deadline
// decides the refusal was real.
const REFUSED = /you can'?t join this video call/i;
const TRY_AGAIN = 'name:^try again$';

/** Hang up the way a person does: click the call's leave button and wait
 *  for the page to acknowledge — the button gone, Meet dropping you on a
 *  rejoin screen. Closing the tab without this leaves the other side a
 *  frozen tile until the media times out (operator, 2026-10-14). Answers
 *  whether the page acknowledged; the caller closes the tab either way. */
export async function driveLeave(tab: Tab, log: MeetLog): Promise<boolean> {
  const leave = tab.locator('name:leave call|leave meeting|hang up');
  let button: string;
  try {
    button = await leave.click({ timeoutMs: 3_000 });
  } catch {
    return false; // no button or it stayed disabled: the tab close is the fallback
  }
  log('meet.leave-clicked', { button });
  try {
    await tab.waitFor(
      () =>
        !Array.from(document.querySelectorAll('button, [role="button"]')).some(
          el =>
            /leave call|leave meeting|hang up/i.test((el.getAttribute('aria-label') || el.textContent || '').trim()) &&
            !(el as HTMLButtonElement).disabled,
        ),
      { timeoutMs: 5_000, intervalMs: 250 },
    );
    return true;
  } catch {
    return false; // the page kept the button; the tab close follows anyway
  }
}

/** Click through Meet's screens to the call. Throws when Meet wants a
 *  Google account (v1 joins as a guest), when the screens never resolve,
 *  or when the host never admits. */
export async function driveJoin(tab: Tab, options: JoinOptions): Promise<Joined> {
  const joinTimeoutMs = options.joinTimeoutMs ?? 60_000;
  const askTimeoutMs = options.askTimeoutMs ?? 15 * 60_000;
  const dialog = tab.locator(DIALOG);
  const muteButton = tab.locator(MUTE_BUTTON);
  const nameBox = tab.locator(NAME_BOX);
  const ask = tab.locator(ASK);
  const tryAgain = tab.locator(TRY_AGAIN);
  const step = async (label: string): Promise<void> => {
    if (options.onStep !== undefined) await options.onStep(label);
  };
  const title = () => tab.call((): string => document.title);
  /** What the page offers, in the words the debug lines carry. */
  const said = (screen: Screen): string[] =>
    screen.buttons
      .map(b => b.name)
      .filter(Boolean)
      .slice(0, 12);
  /** Unmute and WAIT for the page to say it took (the attribute flips to
   *  `want`) before any further click. The race, caught in the host log
   *  2026-10-14: `mic-live` and the ask click 6 ms apart in one pass —
   *  Meet refused the guest seconds after that double-tap, and retested
   *  passes that happened to split them across passes joined fine. A
   *  human unmutes, sees the mic go live, then asks; so do we. */
  const unmute = async (want: string): Promise<void> => {
    const button = await muteButton.click();
    options.log('meet.mic-live', { button });
    await step('mic-live');
    try {
      await tab.waitFor(
        (value: string) => {
          const el = document.querySelector('button[data-is-muted]');
          return el !== null && el.getAttribute('data-is-muted') === value;
        },
        { timeoutMs: 3_000, intervalMs: 200 },
        want,
      );
    } catch {
      // the attribute never flipped: said, and the loop re-reads the
      // screen — the next pass decides whether there is still work to do
      options.log('meet.mic-unconfirmed', { hint: 'attribute did not flip after the click' });
    }
  };
  const deadline = Date.now() + joinTimeoutMs;
  let asked = false;
  let refused = false; // did the "you can't join" screen show at any point?
  await step('opened');

  // one pass per 250 ms, and the deadline is the LOOP CONDITION: the only
  // way out other than a click through to the call is the loop ending
  do {
    const screen = await readScreen(tab);
    if (SIGNIN_WALL.test(screen.url)) {
      throw new Error(
        'Meet asked for a Google sign-in — aivi joins as a guest only. Open the meeting link as a signed-out visitor, or start an instant meeting that accepts guests.',
      );
    }
    if (REFUSED.test(screen.words)) {
      // a screen, not a verdict (see REFUSED): click the page's own way
      // out when it offers one, and keep reading. The deadline below is
      // the only thing that calls a refusal real.
      refused = true;
      if (await tryAgain.exists()) {
        options.log('meet.retry-clicked', { button: await tryAgain.click() });
        await step('retry');
      }
    }
    // Meet may re-mute on the admission (it pre-mutes waiting guests, and
    // the mute flag is what gates transmission — a live shim track behind
    // a pink mic is still silence). One last look at the attribute.
    if (inCallOn(screen) && (await muteButton.attr('data-is-muted')) === 'true') {
      await unmute('false');
      continue;
    }
    if (inCallOn(screen)) {
      await step('in-call');
      return { viaWaitingRoom: asked };
    }

    // Act on whatever the screen shows, one thing per pass, and wait for
    // the page to acknowledge before the next click. A click the page
    // did not take leaves its button in place, so the next pass offers
    // it again — screen-driven, the way a person re-clicks a dead button.
    if (await dialog.exists()) {
      options.log('meet.dismissed', { button: await dialog.click() });
      await step('dismissed');
    }
    // aivi's mic is its own synthetic voice — nothing to hide, everything
    // to say — so a button saying muted gets the click, and the page's
    // acknowledgment gates everything after it
    if ((await muteButton.attr('data-is-muted')) === 'true') {
      await unmute('true');
      continue;
    }
    if (!asked) {
      if (await nameBox.exists()) await nameBox.fill(options.name);
      if (await ask.exists()) {
        // blocks until the button is ENABLED — i.e. until Meet accepts the
        // name typed — and then clicks once
        options.log('meet.clicked', { button: await ask.click() });
        await step('clicked');
      }
    }

    // asked is Meet's lobby screen, not our click: only once its waiting
    // words are up is waiting for the host the honest thing to do
    if (!asked && LOBBY.test(screen.words)) {
      asked = true;
      options.log('meet.asked', { name: options.name, hint: 'admitting aivi is the host click; this waits' });
      await step('asked');
    }
    if (asked) {
      await step('waiting');
      // The host's click can take minutes, so this is one bounded wait at
      // a 1 s pace — but it NARRATES: the screen it sees is logged after
      // 3 s and then every 15 s. A wait that cannot say why it waits is
      // how an admitted aivi sat invisible for 3 minutes (2026-10-14).
      // The lobby's own hang-up button must not end it: the waiting
      // words have to be gone as well.
      const until = Date.now() + askTimeoutMs;
      let nextSaid = Date.now() + 3_000;
      // bounded by `until` in the loop tail; it only NARRATES while it
      // stands (3 s, then every 15 s) — a wait that cannot say why it
      // waits is how an admitted aivi sat invisible for 3 minutes
      do {
        const waiting = await readScreen(tab);
        if (inCallOn(waiting)) {
          await step('in-call');
          return { viaWaitingRoom: true };
        }
        if (Date.now() >= nextSaid) {
          nextSaid = Date.now() + 15_000;
          options.log('meet.still-waiting', {
            lobby: LOBBY.test(waiting.words),
            title: await title(),
            buttons: said(waiting),
          });
        }
        await sleep(1_000);
      } while (Date.now() < until);
      throw new Error(`the host never admitted aivi within ${askTimeoutMs} ms (last screen: "${await title()}")`);
    }

    await sleep(250);
  } while (Date.now() < deadline);
  throw new Error(
    refused
      ? 'Meet kept refusing the guest ("you can\'t join this video call" through the whole wait): this meeting only admits people the host invited or let in — or Meet flagged this browser. Start an instant meeting or allow guest access; if the meeting is open and it still refuses, set `headless: false` in `plugins.google-meet` and join again (a visible window always passed).'
      : `Meet's screens did not lead to a call within ${joinTimeoutMs} ms (last screen: "${await title()}")`,
  );
}
