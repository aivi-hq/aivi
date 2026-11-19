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
import { type Locator, sleep, type Tab } from '@aivi/chrome';
import { leaveGone, lookAtScreen, muteSays, type Screen, titleOfPage } from './page.ts';

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

const readScreen = (tab: Tab): Promise<Screen> => tab.call(lookAtScreen);

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
    await tab.waitFor(leaveGone, { timeoutMs: 5_000, intervalMs: 250 });
    return true;
  } catch {
    return false; // the page kept the button; the tab close follows anyway
  }
}

/** What the page offers, in the words the debug lines carry. */
const said = (screen: Screen): string[] =>
  screen.buttons
    .map(b => b.name)
    .filter(Boolean)
    .slice(0, 12);

/** One join: the screens read in passes until the call is on screen, the deadline ends the passes, or the
 *  host's admission is awaited. */
class MeetJoin {
  private readonly tab: Tab;
  private readonly options: JoinOptions;
  private readonly joinTimeoutMs: number;
  private readonly askTimeoutMs: number;
  private readonly dialog: Locator;
  private readonly muteButton: Locator;
  private readonly nameBox: Locator;
  private readonly ask: Locator;
  private readonly tryAgain: Locator;
  private asked = false;
  /** Did the "you can't join" screen show at any point? */
  private refused = false;

  constructor(tab: Tab, options: JoinOptions) {
    this.tab = tab;
    this.options = options;
    this.joinTimeoutMs = options.joinTimeoutMs ?? 60_000;
    this.askTimeoutMs = options.askTimeoutMs ?? 15 * 60_000;
    this.dialog = tab.locator(DIALOG);
    this.muteButton = tab.locator(MUTE_BUTTON);
    this.nameBox = tab.locator(NAME_BOX);
    this.ask = tab.locator(ASK);
    this.tryAgain = tab.locator(TRY_AGAIN);
  }

  async run(): Promise<Joined> {
    const deadline = Date.now() + this.joinTimeoutMs;
    await this.step('opened');

    // one pass per 250 ms, and the deadline is the LOOP CONDITION: the only
    // way out other than a click through to the call is the loop ending
    do {
      const joined = await this.pass();
      if (joined) return joined;
    } while (Date.now() < deadline);
    throw new Error(
      this.refused
        ? 'Meet kept refusing the guest ("you can\'t join this video call" through the whole wait): this meeting only admits people the host invited or let in — or Meet flagged this browser. Start an instant meeting or allow guest access; if the meeting is open and it still refuses, set `headless: false` in `plugins.google-meet` and join again (a visible window always passed).'
        : `Meet's screens did not lead to a call within ${this.joinTimeoutMs} ms (last screen: "${await this.title()}")`,
    );
  }

  private async step(label: string): Promise<void> {
    if (this.options.onStep !== undefined) await this.options.onStep(label);
  }

  private title(): Promise<string> {
    return this.tab.call(titleOfPage);
  }

  /** One look at the screen and at most one thing done about it: the call when it is on screen, nothing
   *  yet otherwise. */
  private async pass(): Promise<Joined | undefined> {
    const screen = await readScreen(this.tab);
    if (SIGNIN_WALL.test(screen.url)) {
      throw new Error(
        'Meet asked for a Google sign-in — aivi joins as a guest only. Open the meeting link as a signed-out visitor, or start an instant meeting that accepts guests.',
      );
    }
    if (REFUSED.test(screen.words)) await this.takeRefusalForAScreen();
    if (inCallOn(screen)) return this.admitted();

    // Act on whatever the screen shows, one thing per pass, and wait for
    // the page to acknowledge before the next click. A click the page
    // did not take leaves its button in place, so the next pass offers
    // it again — screen-driven, the way a person re-clicks a dead button.
    if (await this.dialog.exists()) {
      this.options.log('meet.dismissed', { button: await this.dialog.click() });
      await this.step('dismissed');
    }
    // aivi's mic is its own synthetic voice — nothing to hide, everything
    // to say — so a button saying muted gets the click, and the page's
    // acknowledgment gates everything after it
    if ((await this.muteButton.attr('data-is-muted')) === 'true') {
      await this.unmute('true');
      return undefined;
    }
    if (!this.asked) await this.typeNameAndAsk();

    // asked is Meet's lobby screen, not our click: only once its waiting
    // words are up is waiting for the host the honest thing to do
    if (!this.asked && LOBBY.test(screen.words)) {
      this.asked = true;
      this.options.log('meet.asked', {
        name: this.options.name,
        hint: 'admitting aivi is the host click; this waits',
      });
      await this.step('asked');
    }
    if (this.asked) return this.waitForHost();

    await sleep(250);
    return undefined;
  }

  /** A refusal is a screen, not a verdict (see REFUSED): click the page's own way out when it offers one, and
   *  keep reading. The deadline is the only thing that calls a refusal real. */
  private async takeRefusalForAScreen(): Promise<void> {
    this.refused = true;
    if (await this.tryAgain.exists()) {
      this.options.log('meet.retry-clicked', { button: await this.tryAgain.click() });
      await this.step('retry');
    }
  }

  /** The call is on screen. Meet may re-mute on the admission (it pre-mutes waiting guests, and the mute flag is
   *  what gates transmission — a live shim track behind a pink mic is still silence): one last look at the
   *  attribute, and the pass ends there to read the screen again. */
  private async admitted(): Promise<Joined | undefined> {
    if ((await this.muteButton.attr('data-is-muted')) === 'true') {
      await this.unmute('false');
      return undefined;
    }
    await this.step('in-call');
    return { viaWaitingRoom: this.asked };
  }

  /** Unmute and WAIT for the page to say it took (the attribute flips to
   *  `want`) before any further click. The race, caught in the host log
   *  2026-10-14: `mic-live` and the ask click 6 ms apart in one pass —
   *  Meet refused the guest seconds after that double-tap, and retested
   *  passes that happened to split them across passes joined fine. A
   *  human unmutes, sees the mic go live, then asks; so do we. */
  private async unmute(want: string): Promise<void> {
    const button = await this.muteButton.click();
    this.options.log('meet.mic-live', { button });
    await this.step('mic-live');
    try {
      await this.tab.waitFor(muteSays, { timeoutMs: 3_000, intervalMs: 200 }, want);
    } catch {
      // the attribute never flipped: said, and the loop re-reads the
      // screen — the next pass decides whether there is still work to do
      this.options.log('meet.mic-unconfirmed', { hint: 'attribute did not flip after the click' });
    }
  }

  private async typeNameAndAsk(): Promise<void> {
    if (await this.nameBox.exists()) await this.nameBox.fill(this.options.name);
    if (await this.ask.exists()) {
      // blocks until the button is ENABLED — i.e. until Meet accepts the
      // name typed — and then clicks once
      this.options.log('meet.clicked', { button: await this.ask.click() });
      await this.step('clicked');
    }
  }

  /** The host's click can take minutes, so this is one bounded wait at
   *  a 1 s pace — but it NARRATES: the screen it sees is logged after
   *  3 s and then every 15 s. A wait that cannot say why it waits is
   *  how an admitted aivi sat invisible for 3 minutes (2026-10-14).
   *  The lobby's own hang-up button must not end it: the waiting
   *  words have to be gone as well. */
  private async waitForHost(): Promise<Joined> {
    await this.step('waiting');
    const until = Date.now() + this.askTimeoutMs;
    let nextSaid = Date.now() + 3_000;
    // bounded by `until` in the loop tail; it only NARRATES while it
    // stands (3 s, then every 15 s)
    do {
      const waiting = await readScreen(this.tab);
      if (inCallOn(waiting)) {
        await this.step('in-call');
        return { viaWaitingRoom: true };
      }
      if (Date.now() >= nextSaid) {
        nextSaid = Date.now() + 15_000;
        this.options.log('meet.still-waiting', {
          lobby: LOBBY.test(waiting.words),
          title: await this.title(),
          buttons: said(waiting),
        });
      }
      await sleep(1_000);
    } while (Date.now() < until);
    throw new Error(
      `the host never admitted aivi within ${this.askTimeoutMs} ms (last screen: "${await this.title()}")`,
    );
  }
}

/** Click through Meet's screens to the call. Throws when Meet wants a
 *  Google account (v1 joins as a guest), when the screens never resolve,
 *  or when the host never admits. */
export async function driveJoin(tab: Tab, options: JoinOptions): Promise<Joined> {
  return new MeetJoin(tab, options).run();
}
