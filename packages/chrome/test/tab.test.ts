/** `Tab`: one tab of a browser. Its one collaborator is the connection, here
 *  `stubConnection`: `send` answers what the browser would answer and records
 *  what it was asked. The code that runs inside the page is `page.ts`, tested
 *  in `page.test.ts`; here the page is a `Runtime.evaluate` answer. */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { type TestContext, test } from 'node:test';
import { CdpError, CdpEvent, Tab } from '../src/index.ts';
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
import { stubConnection } from './connection-stub.ts';

type PageFunction = (...args: never[]) => unknown;

function fixture(t: TestContext, answers: Record<string, unknown> = {}) {
  const connection = stubConnection(t, answers);
  return { connection, tab: new Tab(connection, 'target-1', 'session-1') };
}

/** What `Tab` sends to run something in the page. */
const evaluation = (expression: string) => [
  'Runtime.evaluate',
  { expression, awaitPromise: true, returnByValue: true },
  'session-1',
];

/** The page as `Runtime.evaluate` reaches it: each page function has its own
 *  answers, given in turn, the last one for ever after. */
function pageSays(says: Array<[PageFunction, ...unknown[]]>) {
  const looks = new Map<PageFunction, number>();
  return (params: any) => {
    const expression = String(params.expression);
    for (const [fn, ...values] of says) {
      if (!expression.startsWith(`(${fn})(`)) continue;
      const n = looks.get(fn) ?? 0;
      looks.set(fn, n + 1);
      return { result: { value: values[Math.min(n, values.length - 1)] } };
    }
    throw new Error(`the page was asked something unexpected: ${expression}`);
  };
}

/** True when the promise has not settled once the event loop has turned. */
const stillWaiting = (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    new Promise<boolean>(resolve => setImmediate(() => resolve(true))),
  ]);

const loadOf = (sessionId?: string) => new CdpEvent('Page.loadEventFired', { sessionId });

const GIVE_UP = { timeoutMs: 5, intervalMs: 1 };
const PATIENT = { timeoutMs: 1_000, intervalMs: 1 };

test('a tab knows its target and its session', t => {
  const { tab } = fixture(t);

  assert.deepEqual([tab.targetId, tab.sessionId], ['target-1', 'session-1']);
});

test('send addresses the tab, and answers what the browser answered', async t => {
  const { connection, tab } = fixture(t, { 'Page.reload': { done: true } });

  assert.deepEqual(await tab.send('Page.reload', { ignoreCache: true }), { done: true });
  await tab.send('Page.reload');

  assert.deepEqual(connection.sent(), [
    ['Page.reload', { ignoreCache: true }, 'session-1'],
    ['Page.reload', {}, 'session-1'],
  ]);
});

test('on hears the events of this tab only, and off stops it', t => {
  const { connection, tab } = fixture(t);
  const heard: string[] = [];
  const listener = (event: CdpEvent) => heard.push(`${event.type} ${event.sessionId}`);

  assert.equal(tab.on('Page.loadEventFired', listener), tab);
  connection.dispatchEvent(loadOf('session-1'));
  connection.dispatchEvent(loadOf('other-session'));
  connection.dispatchEvent(loadOf());
  connection.dispatchEvent(new CdpEvent('Page.frameNavigated', { sessionId: 'session-1' }));
  assert.deepEqual(heard, ['Page.loadEventFired session-1']);

  assert.equal(tab.off('Page.loadEventFired', listener), tab);
  connection.dispatchEvent(loadOf('session-1'));
  assert.equal(heard.length, 1);
  assert.equal(tab.off('Page.loadEventFired', listener), tab, 'taking off what is not on is harmless');
});

test('one listener on two events is taken off the event that is asked for, and keeps hearing the other', t => {
  const { connection, tab } = fixture(t);
  const heard: string[] = [];
  const listener = (event: CdpEvent) => heard.push(event.type);
  tab.on('A.one', listener).on('B.two', listener);

  tab.off('A.one', listener);
  connection.dispatchEvent(new CdpEvent('A.one', { sessionId: 'session-1' }));
  connection.dispatchEvent(new CdpEvent('B.two', { sessionId: 'session-1' }));
  assert.deepEqual(heard, ['B.two']);

  tab.off('B.two', listener);
  connection.dispatchEvent(new CdpEvent('B.two', { sessionId: 'session-1' }));
  assert.deepEqual(heard, ['B.two']);
});

test('the same listener on the same event twice is one registration', t => {
  const { connection, tab } = fixture(t);
  const heard: string[] = [];
  const listener = (event: CdpEvent) => heard.push(event.type);
  tab.on('A.one', listener).on('A.one', listener);

  connection.dispatchEvent(new CdpEvent('A.one', { sessionId: 'session-1' }));
  assert.deepEqual(heard, ['A.one']);

  tab.off('A.one', listener);
  connection.dispatchEvent(new CdpEvent('A.one', { sessionId: 'session-1' }));
  assert.deepEqual(heard, ['A.one']);
});

test('goto enables the page once, navigates, and ends on the load of this tab, even one that beats the answer', async t => {
  const { connection, tab } = fixture(t, { 'Page.enable': {} });
  connection.answers['Page.navigate'] = () => {
    connection.dispatchEvent(loadOf('session-1'));
    return { frameId: 'frame-1' };
  };

  await tab.goto('https://meet.test/abc');
  await tab.goto('https://meet.test/def');

  assert.deepEqual(connection.sent(), [
    ['Page.enable', {}, 'session-1'],
    ['Page.navigate', { url: 'https://meet.test/abc' }, 'session-1'],
    ['Page.navigate', { url: 'https://meet.test/def' }, 'session-1'],
  ]);
});

test('goto is not ended by the load of another tab', async t => {
  const { connection, tab } = fixture(t, { 'Page.enable': {} });
  connection.answers['Page.navigate'] = () => {
    connection.dispatchEvent(loadOf('other-session'));
    return { frameId: 'frame-1' };
  };

  const going = tab.goto('https://meet.test/abc');
  assert.equal(await stillWaiting(going), true);
  connection.dispatchEvent(loadOf('session-1'));

  await going;
});

test('by default goto waits 30 seconds for the load', async t => {
  const timers = t.mock.method(globalThis, 'setTimeout');
  const { connection, tab } = fixture(t, { 'Page.enable': {} });
  connection.answers['Page.navigate'] = () => {
    connection.dispatchEvent(loadOf('session-1'));
    return {};
  };

  await tab.goto('https://meet.test/abc');

  assert.deepEqual(
    timers.mock.calls.map(call => call.arguments[1]),
    [30_000],
  );
});

test('goto fails with the error text of the browser, and leaves nothing waiting for the load', async t => {
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const { connection, tab } = fixture(t, {
    'Page.enable': {},
    'Page.navigate': { errorText: 'net::ERR_NAME_NOT_RESOLVED' },
  });

  await assert.rejects(
    tab.goto('https://nope.test'),
    new Error('navigation to https://nope.test failed: net::ERR_NAME_NOT_RESOLVED'),
  );

  assert.equal(getEventListeners(connection, 'Page.loadEventFired').length, 0);
  assert.ok(cleared.mock.callCount() >= 1, 'the timer of the wait is cleared');
});

test('a navigate command that fails leaves nothing waiting for the load', async t => {
  const { connection, tab } = fixture(t, { 'Page.enable': {} });
  const refused = new CdpError('the target is gone when calling Page.navigate', -32000);
  connection.answers['Page.navigate'] = () => {
    throw refused;
  };

  await assert.rejects(tab.goto('https://meet.test/abc'), refused);

  assert.equal(getEventListeners(connection, 'Page.loadEventFired').length, 0);
});

test('goto gives up when the load does not come in time, and leaves nothing waiting', async t => {
  const { connection, tab } = fixture(t, { 'Page.enable': {}, 'Page.navigate': {} });

  await assert.rejects(
    tab.goto('https://meet.test/abc', { timeoutMs: 5 }),
    new Error('no Page.loadEventFired within 5 ms'),
  );

  assert.equal(getEventListeners(connection, 'Page.loadEventFired').length, 0);
});

test('a load that times out while navigate is still unanswered is the error of goto, not of the process', async t => {
  const { connection, tab } = fixture(t, { 'Page.enable': {} });
  connection.answers['Page.navigate'] = () => new Promise(resolve => setTimeout(() => resolve({}), 10));

  await assert.rejects(
    tab.goto('https://meet.test/abc', { timeoutMs: 2 }),
    new Error('no Page.loadEventFired within 2 ms'),
  );
});

test('evaluate runs an expression in the page and takes its value back', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': { result: { type: 'number', value: 2 } } });

  assert.equal(await tab.evaluate<number>('1 + 1'), 2);

  assert.deepEqual(connection.sent(), [evaluation('1 + 1')]);
});

test('evaluate answers undefined when the page gave no value', async t => {
  const { tab, connection } = fixture(t, { 'Runtime.evaluate': { result: { type: 'undefined' } } });
  assert.equal(await tab.evaluate('undefined'), undefined);

  connection.answers['Runtime.evaluate'] = {};
  assert.equal(await tab.evaluate('anything'), undefined);
});

for (const [name, details, message] of [
  [
    'what the page said',
    { text: 'Uncaught', exception: { description: 'ReferenceError: x is not defined' } },
    'ReferenceError: x is not defined',
  ],
  ['the label of the page when there is no description', { text: 'Uncaught' }, 'Uncaught'],
  ['a plain sentence when there is nothing else', {}, 'the page function threw'],
] as const) {
  test(`a page that threw is an Error with ${name}`, async t => {
    const { tab } = fixture(t, { 'Runtime.evaluate': { result: {}, exceptionDetails: details } });

    await assert.rejects(tab.evaluate('x'), new Error(message));
  });
}

test('call sends a function as source text, with its arguments as JSON', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': { result: { value: 'ok' } } });
  const pageFunction = (a: number, b: string, c: { k: string }, d?: number) => `${a}${b}${c.k}${d}`;

  assert.equal(await tab.call(pageFunction, 1, 'two', { k: 'v' }, undefined), 'ok');

  assert.deepEqual(connection.sent(), [evaluation(`(${pageFunction})(1, "two", {"k":"v"}, undefined)`)]);
});

test('call also takes source text that was built elsewhere', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': { result: { value: 42 } } });

  assert.equal(await tab.call('(x) => x * 2', 21), 42);

  assert.deepEqual(connection.sent(), [evaluation('((x) => x * 2)(21)')]);
});

test('waitFor looks again until the answer is truthy, and answers it', async t => {
  const pageFunction = (what: string) => what;
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([[pageFunction, 0, '', null, 'ready']]),
  });

  assert.equal(await tab.waitFor(pageFunction, { timeoutMs: 1_000, intervalMs: 1 }, 'ready'), 'ready');

  assert.deepEqual(connection.sent(), Array(4).fill(evaluation(`(${pageFunction})("ready")`)));
});

test('waitFor gives up after timeoutMs and names what it waited for', async t => {
  const never = () => false;
  const { tab } = fixture(t, { 'Runtime.evaluate': pageSays([[never, false]]) });

  await assert.rejects(tab.waitFor(never, GIVE_UP), new Error('no () => false within 5 ms'));
});

test('a long source is cut to 120 characters in what waitFor names', async t => {
  const { tab } = fixture(t, { 'Runtime.evaluate': { result: { value: false } } });

  await assert.rejects(tab.waitFor('x'.repeat(130), GIVE_UP), new Error(`no ${'x'.repeat(120)}… within 5 ms`));
});

test('waitForSelector and waitForText look for the selector and for the words', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': { result: { value: true } } });

  await tab.waitForSelector('#join');
  await tab.waitForText('Ask to join');

  assert.deepEqual(connection.sent(), [
    evaluation(`(${hasSelector})("#join")`),
    evaluation(`(${hasText})("Ask to join")`),
  ]);
});

test('waitForSelector and waitForText give up after timeoutMs', async t => {
  const { tab } = fixture(t, { 'Runtime.evaluate': { result: { value: false } } });

  await assert.rejects(
    tab.waitForSelector('#join', GIVE_UP),
    /^Error: no .*querySelector\(sel\) !== null within 5 ms$/s,
  );
  await assert.rejects(tab.waitForText('Ask to join', GIVE_UP), /^Error: no .*includes\(text\) within 5 ms$/s);
});

test('a locator keeps the matcher it was made from', t => {
  const { tab } = fixture(t);

  assert.equal(tab.locator('name:Ask to join').matcher, 'name:Ask to join');
});

test('a locator tells whether the element is there, whether it is enabled, and what an attribute says', async t => {
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([[locate, { label: 'Join', enabled: false }, null, { label: 'Join', enabled: true }]]),
  });
  const mic = tab.locator('#mic');

  assert.equal(await mic.exists(), true, 'disabled counts');
  assert.equal(await mic.exists(), false);
  assert.equal(await mic.enabled(), true);
  connection.answers['Runtime.evaluate'] = pageSays([
    [locate, { label: 'Mic', enabled: true, attr: 'false' }, null, { label: 'Mic', enabled: true }],
  ]);
  assert.equal(await mic.attr('data-is-muted'), 'false');
  assert.equal(await mic.attr('data-is-muted'), undefined, 'no element');
  assert.equal(await mic.attr('data-is-muted'), undefined, 'no attribute');

  assert.deepEqual(connection.sent(), [
    evaluation(`(${locate})("css", "#mic", "")`),
    evaluation(`(${locate})("css", "#mic", "")`),
    evaluation(`(${locate})("css", "#mic", "")`),
    evaluation(`(${locate})("css", "#mic", "data-is-muted")`),
    evaluation(`(${locate})("css", "#mic", "data-is-muted")`),
    evaluation(`(${locate})("css", "#mic", "data-is-muted")`),
  ]);
});

test('a name matcher is sent as a name, a CSS selector as css', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': { result: { value: null } } });

  await tab.exists('name:Ask to join');
  await tab.exists('button.primary');

  assert.deepEqual(connection.sent(), [
    evaluation(`(${locate})("name", "Ask to join", "")`),
    evaluation(`(${locate})("css", "button.primary", "")`),
  ]);
});

test('a locator waits until the element is there', async t => {
  const there = { label: 'Join', enabled: false };
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': pageSays([[locate, null, null, there]]) });

  await tab.locator('#join').waitFor(PATIENT);

  assert.equal(connection.sent().length, 3);
});

test('a locator gives up waiting for an element after timeoutMs', async t => {
  const { tab } = fixture(t, { 'Runtime.evaluate': pageSays([[locate, null]]) });

  await assert.rejects(tab.locator('#join').waitFor(GIVE_UP), new Error('no element #join within 5 ms'));
});

test('click waits until the page takes the click, once, and answers the words of what it clicked', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': pageSays([[clickLocated, null, null, 'Join']]) });

  assert.equal(await tab.locator('name:Join').click(PATIENT), 'Join');

  assert.deepEqual(connection.sent(), Array(3).fill(evaluation(`(${clickLocated})("name", "Join")`)));
});

test('click says there was no element when the page never had one', async t => {
  const { tab } = fixture(t, {
    'Runtime.evaluate': pageSays([
      [clickLocated, null],
      [locate, null],
    ]),
  });

  await assert.rejects(tab.locator('#join').click(GIVE_UP), new Error('no element matching #join within 5 ms'));
});

test('click says the page never took it when the element stayed disabled', async t => {
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([
      [clickLocated, null],
      [locate, { label: 'Join', enabled: false }],
    ]),
  });

  await assert.rejects(
    tab.locator('#join').click(GIVE_UP),
    new Error('#join stayed disabled for 5 ms — the page never took it'),
  );

  assert.deepEqual(connection.sent().at(-1), evaluation(`(${locate})("css", "#join", "")`));
});

test('fill waits for the element, then types into it', async t => {
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([
      [locate, null, { label: 'Your name', enabled: true }],
      [fillLocated, 'filled'],
    ]),
  });

  await tab.locator('#name').fill('aivi', PATIENT);

  assert.deepEqual(connection.sent().at(-1), evaluation(`(${fillLocated})("css", "#name", "aivi")`));
});

for (const [answer, message] of [
  ['absent', '#name vanished before the fill'],
  ['not-an-input', 'cannot fill #name: it is not an <input>'],
] as const) {
  test(`fill says so when the page answers ${answer}`, async t => {
    const { tab } = fixture(t, {
      'Runtime.evaluate': pageSays([
        [locate, { label: 'Your name', enabled: true }],
        [fillLocated, answer],
      ]),
    });

    await assert.rejects(tab.locator('#name').fill('aivi', PATIENT), new Error(message));
  });
}

test('exists, click and fill on the tab are the verbs of a locator for that matcher', async t => {
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([
      [locate, { label: 'Join', enabled: true }],
      [clickLocated, 'Join'],
      [fillLocated, 'filled'],
    ]),
  });

  assert.equal(await tab.exists('name:Join'), true);
  assert.equal(await tab.click('name:Join'), 'Join');
  await tab.fill('#name', 'aivi');

  assert.deepEqual(connection.sent(), [
    evaluation(`(${locate})("name", "Join", "")`),
    evaluation(`(${clickLocated})("name", "Join")`),
    evaluation(`(${locate})("css", "#name", "")`),
    evaluation(`(${fillLocated})("css", "#name", "aivi")`),
  ]);
});

test('click and fill on the tab pass their wait options on to the locator', async t => {
  const { tab } = fixture(t, {
    'Runtime.evaluate': pageSays([
      [clickLocated, null],
      [locate, null],
    ]),
  });

  await assert.rejects(tab.click('#join', GIVE_UP), new Error('no element matching #join within 5 ms'));
  await assert.rejects(tab.fill('#name', 'aivi', GIVE_UP), new Error('no element #name within 5 ms'));
});

test('words, text and attr read the page', async t => {
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([
      [readWords, 'Ask to join'],
      [readText, 'Join now'],
      [readAttribute, '/join'],
    ]),
  });

  assert.equal(await tab.words(), 'Ask to join');
  assert.equal(await tab.text('#join'), 'Join now');
  assert.equal(await tab.attr('a', 'href'), '/join');

  assert.deepEqual(connection.sent(), [
    evaluation(`(${readWords})()`),
    evaluation(`(${readText})("#join")`),
    evaluation(`(${readAttribute})("a", "href")`),
  ]);
});

test('url is the location of the page', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': { result: { value: 'https://meet.test/abc' } } });

  assert.equal(await tab.url(), 'https://meet.test/abc');

  assert.deepEqual(connection.sent(), [evaluation('location.href')]);
});

test('screenshot is the PNG the browser sends, as bytes', async t => {
  const { connection, tab } = fixture(t, {
    'Page.captureScreenshot': { data: Buffer.from('png bytes').toString('base64') },
  });

  assert.deepEqual(await tab.screenshot(), Buffer.from('png bytes'));

  assert.deepEqual(connection.sent(), [['Page.captureScreenshot', { format: 'png' }, 'session-1']]);
});

test('close closes the target on the browser, not through the session of the tab', async t => {
  const { connection, tab } = fixture(t, { 'Target.closeTarget': { success: true } });

  await tab.close();

  assert.deepEqual(connection.sent(), [['Target.closeTarget', { targetId: 'target-1' }]]);
});

test('hideHeadless puts Chrome where HeadlessChrome was, with the client hints of the browser', async t => {
  const metadata = { brands: [{ brand: 'Chromium', version: '141' }], platform: 'macOS' };
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([[readUserAgent, 'Mozilla/5.0 HeadlessChrome/141.0.0.0 Safari/537.36']]),
    'Browser.getVersion': { userAgentMetadata: metadata },
    'Network.setUserAgentOverride': {},
  });

  assert.equal(await tab.hideHeadless(), true);

  assert.deepEqual(connection.sent(), [
    evaluation(`(${readUserAgent})()`),
    ['Browser.getVersion', {}, 'session-1'],
    [
      'Network.setUserAgentOverride',
      { userAgent: 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36', userAgentMetadata: metadata },
      'session-1',
    ],
  ]);
});

test('hideHeadless leaves out the client hints the browser did not give', async t => {
  const { connection, tab } = fixture(t, {
    'Runtime.evaluate': pageSays([[readUserAgent, 'HeadlessChrome/141.0.0.0']]),
    'Browser.getVersion': {},
    'Network.setUserAgentOverride': {},
  });

  assert.equal(await tab.hideHeadless(), true);

  assert.deepEqual(connection.sent().at(-1), [
    'Network.setUserAgentOverride',
    { userAgent: 'Chrome/141.0.0.0' },
    'session-1',
  ]);
});

test('hideHeadless does nothing when the page does not say it is headless', async t => {
  const { connection, tab } = fixture(t, { 'Runtime.evaluate': pageSays([[readUserAgent, 'Chrome/141.0.0.0']]) });

  assert.equal(await tab.hideHeadless(), false);

  assert.deepEqual(connection.sent(), [evaluation(`(${readUserAgent})()`)]);
});
