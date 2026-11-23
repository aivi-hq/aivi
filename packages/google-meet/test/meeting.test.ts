/** `driveJoin` and `driveLeave`: the Meet buttons, pressed in order. Their one
 *  collaborator is the tab, so each test hands them a tab whose locators answer
 *  what the page would, and whose `call` reads the screens the page would show,
 *  one per look. Time is the other thing they reach: they sleep between looks,
 *  so `setTimeout` answers at once and moves `Date` on by the time it was asked
 *  for. A test then checks the steps, the log lines and the pauses exactly. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { Tab } from '@aivi/chrome';
import { driveJoin, driveLeave, type JoinOptions } from '../src/meeting.ts';
import { leaveGone, lookAtScreen, muteSays, type Screen, titleOfPage } from '../src/page.ts';

const MEET = 'https://meet.google.com/abc-defg-hij';
const DIALOG = 'name:^(not now|no thanks|later|skip|got it|ok|keep calling)$';
const MUTE_BUTTON = 'button[data-is-muted]';
const NAME_BOX = 'input[aria-label="Your name"], input[aria-label="full name"], input[placeholder="Your name"]';
const ASK = 'name:^(ask to join|join now|join|join in)$';
const TRY_AGAIN = 'name:^try again$';
const LEAVE = 'name:leave call|leave meeting|hang up';
const LOBBY_WORDS = 'Please wait until a meeting host brings you into the call';

const screen = (words: string, buttons: Screen['buttons'] = [], url = MEET): Screen => ({ url, words, buttons });
const prejoin = screen('Ready to join?', [{ name: 'Ask to join', enabled: true }]);
const lobby = screen(LOBBY_WORDS, [{ name: 'Leave call', enabled: true }]);
const inCall = screen('Meeting details', [{ name: 'Leave call', enabled: true }]);
const refused = screen("You can't join this video call");

function stubLocator(t: TestContext, matcher: string) {
  return {
    exists: t.mock.fn(async () => false),
    click: t.mock.fn(async (_options?: object) => matcher),
    fill: t.mock.fn(async (_value: string) => {}),
    attr: t.mock.fn(async (_name: string): Promise<string | undefined> => undefined),
  };
}

/** Time passes only when the code sleeps: `setTimeout` answers at once and
 *  moves `Date` on by the time it was asked for. Answers the pauses, in order. */
function sleepsAdvanceTime(t: TestContext): number[] {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const slept: number[] = [];
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, ms: number) => {
    slept.push(ms);
    t.mock.timers.tick(ms);
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
  return slept;
}

/** The tab as `driveJoin` reaches it: the locators it makes, the screens that
 *  `tab.call` reads (one per look, the last for ever after), and the waits. */
function meet(t: TestContext, ...screens: Screen[]) {
  const slept = sleepsAdvanceTime(t);
  const locators = new Map<string, ReturnType<typeof stubLocator>>();
  const locator = (matcher: string) => {
    let found = locators.get(matcher);
    if (found === undefined) {
      found = stubLocator(t, matcher);
      locators.set(matcher, found);
    }
    return found;
  };
  let looks = 0;
  const call = t.mock.fn(async (fn: unknown): Promise<unknown> => {
    if (fn === lookAtScreen) return screens[Math.min(looks++, screens.length - 1)];
    if (fn === titleOfPage) return 'Meet';
    throw new Error('the page was asked something unexpected');
  });
  const waitFor = t.mock.fn(async (_condition: unknown, _options?: object, ..._args: unknown[]) => true);
  const tab = { locator, call, waitFor } as unknown as Tab;
  const log = t.mock.fn((_msg: string, _extra?: Record<string, unknown>) => {});
  const steps: string[] = [];
  const onStep = async (label: string): Promise<void> => {
    steps.push(label);
  };
  return {
    tab,
    locator,
    waitFor,
    log,
    steps,
    slept,
    said: () => log.mock.calls.map(call => call.arguments),
    join: (extra: Partial<JoinOptions> = {}) => driveJoin(tab, { name: 'aivi', log, onStep, ...extra }),
    joinQuietly: () => driveJoin(tab, { name: 'aivi', log }),
  };
}

test('driveJoin is done at once when the call is on screen', async t => {
  const m = meet(t, inCall);

  assert.deepEqual(await m.join(), { viaWaitingRoom: false });

  assert.deepEqual(m.steps, ['opened', 'in-call']);
  assert.deepEqual(m.said(), []);
  assert.deepEqual(m.slept, []);
});

test('driveJoin needs no onStep', async t => {
  const m = meet(t, inCall);

  assert.deepEqual(await m.joinQuietly(), { viaWaitingRoom: false });

  assert.deepEqual(m.steps, []);
});

test('driveJoin refuses a Google sign-in, which a guest cannot give', async t => {
  const m = meet(t, screen('Sign in', [], 'https://accounts.google.com/ServiceLogin?continue=meet'));

  await assert.rejects(m.join(), /^Error: Meet asked for a Google sign-in — aivi joins as a guest only\./);

  assert.deepEqual(m.steps, ['opened']);
});

test('driveJoin dismisses a dialog that stands in the way, then finds the call', async t => {
  const m = meet(t, prejoin, inCall);
  m.locator(DIALOG).exists.mock.mockImplementationOnce(async () => true);
  m.locator(DIALOG).click.mock.mockImplementation(async () => 'Not now');

  assert.deepEqual(await m.join(), { viaWaitingRoom: false });

  assert.deepEqual(m.steps, ['opened', 'dismissed', 'in-call']);
  assert.deepEqual(m.said(), [['meet.dismissed', { button: 'Not now' }]]);
  assert.deepEqual(m.slept, [250]);
});

test('driveJoin types the name, asks to join, and waits in the lobby until the host lets it in', async t => {
  const m = meet(t, prejoin, lobby, inCall);
  m.locator(NAME_BOX).exists.mock.mockImplementationOnce(async () => true);
  m.locator(ASK).exists.mock.mockImplementationOnce(async () => true);
  m.locator(ASK).click.mock.mockImplementation(async () => 'Ask to join');

  assert.deepEqual(await m.join(), { viaWaitingRoom: true });

  assert.deepEqual(
    m.locator(NAME_BOX).fill.mock.calls.map(call => call.arguments),
    [['aivi']],
  );
  assert.deepEqual(m.steps, ['opened', 'clicked', 'asked', 'waiting', 'in-call']);
  assert.deepEqual(m.said(), [
    ['meet.clicked', { button: 'Ask to join' }],
    ['meet.asked', { name: 'aivi', hint: 'admitting aivi is the host click; this waits' }],
  ]);
});

test('driveJoin unmutes the mic before it asks, waits for the page to take the click, and looks again at once', async t => {
  const m = meet(t, prejoin, inCall);
  m.locator(MUTE_BUTTON).attr.mock.mockImplementationOnce(async () => 'true');
  m.locator(MUTE_BUTTON).click.mock.mockImplementation(async () => 'Turn on microphone');

  await m.join();

  assert.deepEqual(m.steps, ['opened', 'mic-live', 'in-call']);
  assert.deepEqual(m.said(), [['meet.mic-live', { button: 'Turn on microphone' }]]);
  assert.deepEqual(
    m.waitFor.mock.calls.map(call => call.arguments.slice(0, 2)),
    [[muteSays, { timeoutMs: 3_000, intervalMs: 200 }]],
  );
  assert.deepEqual(m.slept, []);
});

test('driveJoin says so when the page never confirms the unmute, and reads the screen again', async t => {
  const m = meet(t, prejoin, inCall);
  m.locator(MUTE_BUTTON).attr.mock.mockImplementationOnce(async () => 'true');
  m.locator(MUTE_BUTTON).click.mock.mockImplementation(async () => 'Turn on microphone');
  m.waitFor.mock.mockImplementation(async () => {
    throw new Error('no match within 3000 ms');
  });

  assert.deepEqual(await m.join(), { viaWaitingRoom: false });

  assert.deepEqual(m.said(), [
    ['meet.mic-live', { button: 'Turn on microphone' }],
    ['meet.mic-unconfirmed', { hint: 'attribute did not flip after the click' }],
  ]);
});

test('driveJoin unmutes again when Meet muted the mic on admission', async t => {
  const m = meet(t, inCall);
  m.locator(MUTE_BUTTON).attr.mock.mockImplementationOnce(async () => 'true');
  m.locator(MUTE_BUTTON).click.mock.mockImplementation(async () => 'Turn on microphone');

  assert.deepEqual(await m.join(), { viaWaitingRoom: false });

  assert.deepEqual(m.steps, ['opened', 'mic-live', 'in-call']);
  assert.deepEqual(
    m.waitFor.mock.calls.map(call => call.arguments[2]),
    ['false'],
  );
});

test('driveJoin takes a refusal for a screen, clicks the way out, and only the deadline makes it real', async t => {
  const m = meet(t, refused);
  m.locator(TRY_AGAIN).exists.mock.mockImplementation(async () => true);
  m.locator(TRY_AGAIN).click.mock.mockImplementation(async () => 'Try again');

  await assert.rejects(m.join({ joinTimeoutMs: 1_000 }), /^Error: Meet kept refusing the guest/);

  assert.deepEqual(m.slept, [250, 250, 250, 250]);
  assert.deepEqual(m.said(), Array(4).fill(['meet.retry-clicked', { button: 'Try again' }]));
  assert.deepEqual(m.steps, ['opened', 'retry', 'retry', 'retry', 'retry']);
});

test('driveJoin keeps reading a refusal that offers no way out, and calls it real at the deadline', async t => {
  const m = meet(t, refused);

  await assert.rejects(m.join({ joinTimeoutMs: 1_000 }), /^Error: Meet kept refusing the guest/);

  assert.deepEqual(m.said(), []);
  assert.deepEqual(m.slept, [250, 250, 250, 250]);
});

test('driveJoin gives up when the screens do not lead to a call in time, and says what it last saw', async t => {
  const m = meet(t, prejoin);

  await assert.rejects(
    m.join({ joinTimeoutMs: 1_000 }),
    new Error('Meet\'s screens did not lead to a call within 1000 ms (last screen: "Meet")'),
  );

  assert.deepEqual(m.slept, [250, 250, 250, 250]);
});

test('driveJoin gives up when the host never lets it in', async t => {
  const m = meet(t, lobby);

  await assert.rejects(
    m.join({ askTimeoutMs: 3_000 }),
    new Error('the host never admitted aivi within 3000 ms (last screen: "Meet")'),
  );

  assert.deepEqual(m.steps, ['opened', 'asked', 'waiting']);
  assert.deepEqual(m.slept, [1_000, 1_000, 1_000]);
  assert.deepEqual(
    m.said().map(([message]) => message),
    ['meet.asked'],
  );
});

test('while it waits for the host, driveJoin says what the page shows after 3 seconds, then every 15', async t => {
  const names = [
    'Leave call',
    '',
    'Microphone',
    'Camera',
    'Present',
    'Chat',
    'People',
    'Activities',
    'Raise hand',
    'Captions',
    'More options',
    'Reactions',
    'Settings',
    'Extra',
  ];
  const crowded = screen(
    LOBBY_WORDS,
    names.map(name => ({ name, enabled: true })),
  );
  const m = meet(t, ...Array(20).fill(crowded), inCall);

  assert.deepEqual(await m.join({ askTimeoutMs: 60_000 }), { viaWaitingRoom: true });

  const narrated = ['meet.still-waiting', { lobby: true, title: 'Meet', buttons: names.filter(Boolean).slice(0, 12) }];
  assert.deepEqual(m.said().slice(1), [narrated, narrated]);
  assert.deepEqual(m.slept, Array(19).fill(1_000));
  assert.deepEqual(m.steps, ['opened', 'asked', 'waiting', 'in-call']);
});

test('driveLeave clicks the leave button and says whether the page took it', async t => {
  const m = meet(t);
  m.locator(LEAVE).click.mock.mockImplementation(async () => 'Leave call');

  assert.equal(await driveLeave(m.tab, m.log), true);

  assert.deepEqual(
    m.locator(LEAVE).click.mock.calls.map(call => call.arguments),
    [[{ timeoutMs: 3_000 }]],
  );
  assert.deepEqual(
    m.waitFor.mock.calls.map(call => call.arguments),
    [[leaveGone, { timeoutMs: 5_000, intervalMs: 250 }]],
  );
  assert.deepEqual(m.said(), [['meet.leave-clicked', { button: 'Leave call' }]]);
});

test('driveLeave answers false when there is no button to click, and false when the page keeps it', async t => {
  const m = meet(t);
  m.locator(LEAVE).click.mock.mockImplementationOnce(async () => {
    throw new Error('no element matching name:leave call|leave meeting|hang up within 3000 ms');
  });
  assert.equal(await driveLeave(m.tab, m.log), false);
  assert.equal(m.waitFor.mock.callCount(), 0);
  assert.deepEqual(m.said(), []);

  m.waitFor.mock.mockImplementationOnce(async () => {
    throw new Error('no match within 5000 ms');
  });
  assert.equal(await driveLeave(m.tab, m.log), false);
  assert.deepEqual(m.said(), [['meet.leave-clicked', { button: 'name:leave call|leave meeting|hang up' }]]);
});
