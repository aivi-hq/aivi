/** `createSocketModeConnection`: Slack as the module sees it. What it reaches
 *  are the SDK's two clients and `fetch`: `@slack/web-api` and
 *  `@slack/socket-mode` are module mocks (the real `LogLevel` is kept),
 *  registered before the connection is imported, and `fetch` answers the
 *  `response_url` calls. A test checks what the connection asked of the SDK,
 *  with literal equality, and what it handed back. */
import assert from 'node:assert/strict';
import { mock, type TestContext, test } from 'node:test';
import { ConfigurationError } from '@aivi/plugin';
import * as socketMode from '@slack/socket-mode';

const web = {
  auth: { test: mock.fn<() => Promise<{ user_id?: string }>>() },
  chat: {
    postMessage: mock.fn<(args: Record<string, unknown>) => Promise<{ ts?: string }>>(),
    update: mock.fn<(args: Record<string, unknown>) => Promise<unknown>>(),
    delete: mock.fn<(args: Record<string, unknown>) => Promise<unknown>>(),
  },
  reactions: {
    add: mock.fn<(args: Record<string, unknown>) => Promise<unknown>>(),
    remove: mock.fn<(args: Record<string, unknown>) => Promise<unknown>>(),
  },
  users: { info: mock.fn<(args: { user: string }) => Promise<{ user?: Record<string, unknown> | undefined }>>() },
};
type Listener = (payload: never) => unknown;
const socket = {
  on: mock.fn((_event: string, _listener: Listener) => {}),
  start: mock.fn(async () => {}),
  disconnect: mock.fn(async () => {}),
};

/** What the connection built the two clients with. The clients are classes,
 *  not mock functions: the connection builds them with `new`. */
const built = { web: [] as Array<[string, object]>, socket: [] as object[] };
class WebClient {
  readonly auth = web.auth;
  readonly chat = web.chat;
  readonly reactions = web.reactions;
  readonly users = web.users;

  constructor(token: string, options: object) {
    built.web.push([token, options]);
  }
}
class SocketModeClient {
  readonly on = socket.on;
  readonly start = socket.start;
  readonly disconnect = socket.disconnect;

  constructor(options: object) {
    built.socket.push(options);
  }
}

mock.module('@slack/web-api', { exports: { WebClient } });
mock.module('@slack/socket-mode', { exports: { LogLevel: socketMode.LogLevel, SocketModeClient } });

const { createSocketModeConnection, requireSlackTokens } = await import('../src/connection.ts');

const TOKENS = { bot: 'xoxb-bot', app: 'xapp-app' };

/** A connection, the logger it was given, and the SDK mocks reset to answer
 *  like a healthy Slack. */
function slack(t: TestContext) {
  built.web.length = 0;
  built.socket.length = 0;
  for (const fn of [
    web.auth.test,
    web.chat.postMessage,
    web.chat.update,
    web.chat.delete,
    web.reactions.add,
    web.reactions.remove,
    web.users.info,
    socket.on,
    socket.start,
    socket.disconnect,
  ]) {
    fn.mock.resetCalls();
  }
  web.auth.test.mock.mockImplementation(async () => ({ user_id: 'U0BOT' }));
  web.chat.postMessage.mock.mockImplementation(async () => ({ ts: '1700000000.000100' }));
  for (const fn of [web.chat.update, web.chat.delete, web.reactions.add, web.reactions.remove]) {
    fn.mock.mockImplementation(async () => ({ ok: true }));
  }
  web.users.info.mock.mockImplementation(async () => ({ user: { profile: { display_name: 'Ada' } } }));
  const log = {
    debug: t.mock.fn((_event: string, _fields?: object) => {}),
    info: t.mock.fn((_event: string, _fields?: object) => {}),
    warn: t.mock.fn((_event: string, _fields?: object) => {}),
    error: t.mock.fn((_event: string, _fields?: object) => {}),
  };
  const connection = createSocketModeConnection(TOKENS, log as never);
  return { connection, log };
}

type Calls = { mock: { calls: Array<{ arguments: unknown[] }> } };
const calls = (mock: Calls) => mock.mock.calls.map(call => call.arguments);

/** What the connection registered with the socket for one event. */
const listener = (event: string) => {
  const registered = socket.on.mock.calls.find(call => call.arguments[0] === event);
  assert.ok(registered, `nothing listens for ${event}`);
  return registered.arguments[1] as (payload: unknown) => Promise<void>;
};

test('the tokens come from the environment, and a missing one says how to fix it', () => {
  assert.deepEqual(requireSlackTokens({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }), {
    bot: 'xoxb-1',
    app: 'xapp-1',
  });
  for (const env of [{ SLACK_BOT_TOKEN: 'xoxb-1' }, { SLACK_APP_TOKEN: 'xapp-1' }, {}]) {
    assert.throws(
      () => requireSlackTokens(env),
      error =>
        error instanceof ConfigurationError && /SLACK_BOT_TOKEN \(xoxb-…\) and SLACK_APP_TOKEN/.test(error.message),
    );
  }
});

test('the connection builds the Web API client and the Socket Mode client without retries', t => {
  slack(t);

  assert.deepEqual(built.web, [['xoxb-bot', { retryConfig: { retries: 0 }, timeout: 15000 }]]);
  const options = built.socket[0] as { logger: object } & Record<string, unknown>;
  const { logger, ...rest } = options;
  assert.deepEqual(rest, { appToken: 'xapp-app', clientOptions: { retryConfig: { retries: 0 } } });
  assert.deepEqual(Object.keys(logger).sort(), ['debug', 'error', 'getLevel', 'info', 'setLevel', 'setName', 'warn']);
});

test('the logger given to the SDK sends its lines to the log, under the name the SDK sets', t => {
  const { log } = slack(t);
  const { logger } = built.socket[0] as {
    logger: {
      debug(msg: unknown): void;
      info(msg: unknown): void;
      warn(msg: unknown): void;
      setName(name: string): void;
      setLevel(level: socketMode.LogLevel): void;
      getLevel(): socketMode.LogLevel;
    };
  };

  logger.debug('frame in');
  logger.info('connected');
  logger.setName('socket-mode');
  logger.warn('slow');
  logger.setLevel(socketMode.LogLevel.DEBUG);

  assert.equal(logger.getLevel(), socketMode.LogLevel.DEBUG);
  assert.deepEqual(calls(log.debug), [['slack.debug', { msg: 'slack: frame in' }]]);
  assert.deepEqual(calls(log.info), [['slack.info', { msg: 'slack: connected' }]]);
  assert.deepEqual(calls(log.warn), [['slack.warn', { msg: 'socket-mode: slow' }]]);
});

test('identify answers the bot user id', async t => {
  const { connection } = slack(t);

  assert.deepEqual(await connection.identify(), { userId: 'U0BOT' });
});

for (const code of ['invalid_auth', 'account_inactive', 'token_revoked']) {
  test(`identify says Slack rejected the token when it answers ${code}`, async t => {
    const { connection } = slack(t);
    web.auth.test.mock.mockImplementation(async () => {
      throw Object.assign(new Error('An API error occurred'), { data: { error: code } });
    });

    await assert.rejects(
      connection.identify(),
      error => error instanceof ConfigurationError && error.message === `Slack rejected SLACK_BOT_TOKEN: ${code}`,
    );
  });
}

test('identify passes on any other failure, and refuses an answer without a user id', async t => {
  const { connection } = slack(t);
  const outage = new Error('socket hang up');
  web.auth.test.mock.mockImplementation(async () => {
    throw outage;
  });
  await assert.rejects(connection.identify(), outage);

  web.auth.test.mock.mockImplementation(async () => ({}));
  await assert.rejects(connection.identify(), new Error('Slack auth.test returned no user id'));
});

test('connect listens for the troubles of the socket and logs them, then starts the socket', async t => {
  const { connection, log } = slack(t);

  await connection.connect({ event: async () => {}, command: async () => {} });

  assert.deepEqual(
    calls(socket.on).map(([event]) => event),
    ['error', 'disconnected', 'reconnecting', 'message', 'app_mention', 'slash_commands'],
  );
  assert.equal(socket.start.mock.callCount(), 1);
  const failure = new Error('invalid frame');
  listener('error')(failure);
  listener('disconnected')(undefined);
  listener('reconnecting')(undefined);
  assert.deepEqual(calls(log.warn), [['gateway.error', { error: failure }], ['gateway.disconnected']]);
  assert.deepEqual(calls(log.info), [['gateway.reconnecting']]);
});

test('a message or a mention is acknowledged first, then handed on with the type it arrived as', async t => {
  const { connection } = slack(t);
  const order: string[] = [];
  const handled: unknown[] = [];
  await connection.connect({
    event: async event => {
      order.push('handled');
      handled.push(event);
    },
    command: async () => {},
  });

  for (const type of ['message', 'app_mention']) {
    await listener(type)({
      ack: async () => {
        order.push('ack');
      },
      event: { type: 'something else', channel: 'C1', ts: '1.1', text: 'hi' },
    });
  }

  assert.deepEqual(order, ['ack', 'handled', 'ack', 'handled']);
  assert.deepEqual(handled, [
    { type: 'message', channel: 'C1', ts: '1.1', text: 'hi' },
    { type: 'app_mention', channel: 'C1', ts: '1.1', text: 'hi' },
  ]);
});

test('a slash command is acknowledged first, then handed on', async t => {
  const { connection } = slack(t);
  const order: string[] = [];
  const body = { command: '/aivi', text: 'status', user_id: 'U1', channel_id: 'C1', response_url: 'https://x/y' };
  const handled: unknown[] = [];
  await connection.connect({
    event: async () => {},
    command: async command => {
      order.push('handled');
      handled.push(command);
    },
  });

  await listener('slash_commands')({
    ack: async () => {
      order.push('ack');
    },
    body,
  });

  assert.deepEqual(order, ['ack', 'handled']);
  assert.deepEqual(handled, [body]);
});

test('a handler that fails is logged, and does not stop the acknowledged event', async t => {
  const { connection, log } = slack(t);
  const logged = Promise.withResolvers<void>();
  log.error.mock.mockImplementation(() => {
    logged.resolve();
  });
  const failure = new Error('the turn failed');
  await connection.connect({
    event: async () => {
      throw failure;
    },
    command: async () => {
      throw failure;
    },
  });

  await listener('message')({ ack: async () => {}, event: { channel: 'C1', ts: '1.1' } });
  await logged.promise;
  assert.deepEqual(calls(log.error), [['event.failed', { error: failure }]]);

  const commandLogged = Promise.withResolvers<void>();
  log.error.mock.mockImplementation(() => {
    commandLogged.resolve();
  });
  await listener('slash_commands')({ ack: async () => {}, body: {} });
  await commandLogged.promise;
  assert.equal(calls(log.error)[1]?.[0], 'command.failed');
});

test('disconnect closes the socket, and from then on the warnings of the SDK are dropped but its errors are not', async t => {
  const { connection, log } = slack(t);
  const options = built.socket[0] as { logger: { warn(msg: unknown): void; error(msg: unknown): void } };
  options.logger.warn('before');

  await connection.disconnect();
  options.logger.warn('a pong was not received');
  options.logger.error('still reported');

  assert.equal(socket.disconnect.mock.callCount(), 1);
  assert.deepEqual(calls(log.warn), [['slack.warn', { msg: 'slack: before' }]]);
  assert.deepEqual(calls(log.error), [['slack.error', { msg: 'slack: still reported' }]]);
});

test('post sends markdown as written, with a plain text preview, in the thread when there is one', async t => {
  const { connection } = slack(t);

  assert.deepEqual(await connection.post('C1', '**done**'), { ts: '1700000000.000100' });
  await connection.post('C1', 'in a thread', '1.5');

  const body = (text: string) => ({
    channel: 'C1',
    text,
    blocks: [{ type: 'markdown', text }],
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.deepEqual(calls(web.chat.postMessage), [[body('**done**')], [{ ...body('in a thread'), thread_ts: '1.5' }]]);
});

test('post fails when Slack gives no timestamp back', async t => {
  const { connection } = slack(t);
  web.chat.postMessage.mock.mockImplementation(async () => ({}));

  await assert.rejects(connection.post('C1', 'hi'), new Error('Slack did not return a message timestamp'));
});

test('update, remove, react and unreact ask the Web API for exactly that', async t => {
  const { connection } = slack(t);

  await connection.update('C1', '1.5', 'edited');
  await connection.remove('C1', '1.5');
  await connection.react('C1', '1.5', 'eyes');
  await connection.unreact('C1', '1.5', 'eyes');

  assert.deepEqual(calls(web.chat.update), [
    [{ channel: 'C1', ts: '1.5', text: 'edited', blocks: [{ type: 'markdown', text: 'edited' }] }],
  ]);
  assert.deepEqual(calls(web.chat.delete), [[{ channel: 'C1', ts: '1.5' }]]);
  assert.deepEqual(calls(web.reactions.add), [[{ channel: 'C1', timestamp: '1.5', name: 'eyes' }]]);
  assert.deepEqual(calls(web.reactions.remove), [[{ channel: 'C1', timestamp: '1.5', name: 'eyes' }]]);
});

/** What a `response_url` post carried, as the connection sent it. */
const posted = (fetched: Calls) =>
  fetched.mock.calls.map(({ arguments: [url, init] }) => {
    const { signal, body, ...rest } = init as RequestInit & { signal: unknown; body: string };
    assert.ok(signal instanceof AbortSignal, 'every post is bounded');
    return [url, rest, JSON.parse(body)];
  });

test('an ephemeral answer is posted to the response url as markdown', async t => {
  const { connection, log } = slack(t);
  const fetched = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));

  await connection.ephemeral('https://hooks.slack.test/response', 'only you see this');

  assert.deepEqual(posted(fetched), [
    [
      'https://hooks.slack.test/response',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      {
        response_type: 'ephemeral',
        text: 'only you see this',
        blocks: [{ type: 'markdown', text: 'only you see this' }],
      },
    ],
  ]);
  assert.deepEqual(calls(log.warn), []);
});

for (const [name, answer, warned] of [
  ['a failing status', () => new Response('boom', { status: 500 }), 'Slack response_url answered 500: boom'],
  [
    'a refusal in the body',
    () => Response.json({ ok: false, error: 'invalid_blocks' }),
    'Slack response_url refused: invalid_blocks',
  ],
  ['a refusal without a reason', () => new Response('{"ok":false}'), 'Slack response_url refused: {"ok":false}'],
] as const) {
  test(`an ephemeral answer falls back to plain text after ${name}`, async t => {
    const { connection, log } = slack(t);
    let asked = 0;
    const fetched = t.mock.method(globalThis, 'fetch', async () => (asked++ === 0 ? answer() : new Response('ok')));

    await connection.ephemeral('https://hooks.slack.test/response', 'hello');

    assert.deepEqual(
      posted(fetched).map(([, , body]) => body),
      [
        { response_type: 'ephemeral', text: 'hello', blocks: [{ type: 'markdown', text: 'hello' }] },
        { response_type: 'ephemeral', text: 'hello' },
      ],
    );
    assert.deepEqual(calls(log.warn), [['ephemeral.markdown_rejected', { error: warned }]]);
  });
}

test('an ephemeral answer that fails twice fails with the second error', async t => {
  const { connection } = slack(t);
  let asked = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(asked++ === 0 ? 'first' : 'second', { status: 502 }));

  await assert.rejects(
    connection.ephemeral('https://hooks.slack.test/response', 'hello'),
    new Error('Slack response_url answered 502: second'),
  );
});

for (const body of ['', 'ok', '{"ok":true}', 'something else entirely']) {
  test(`an ephemeral answer that Slack accepts with ${JSON.stringify(body)} is not retried`, async t => {
    const { connection, log } = slack(t);
    const fetched = t.mock.method(globalThis, 'fetch', async () => new Response(body));

    await connection.ephemeral('https://hooks.slack.test/response', 'hello');

    assert.equal(fetched.mock.callCount(), 1);
    assert.deepEqual(calls(log.warn), []);
  });
}

test('userName answers the display name, then the real name, then the handle, then the id', async t => {
  const { connection } = slack(t);
  const answers: Array<Record<string, unknown> | undefined> = [
    { profile: { display_name: 'Ada' }, real_name: 'Ada Lovelace', name: 'ada' },
    { profile: { display_name: '' }, real_name: 'Ada Lovelace', name: 'ada' },
    { profile: {}, real_name: '', name: 'ada' },
    {},
    undefined,
  ];
  web.users.info.mock.mockImplementation(async () => ({ user: answers.shift() }));

  assert.deepEqual(
    [
      await connection.userName('U1'),
      await connection.userName('U1'),
      await connection.userName('U1'),
      await connection.userName('U1'),
      await connection.userName('U1'),
    ],
    ['Ada', 'Ada Lovelace', 'ada', 'U1', 'U1'],
  );
});

test('userName answers the id when Slack cannot be asked', async t => {
  const { connection } = slack(t);
  web.users.info.mock.mockImplementation(async () => {
    throw new Error('user_not_found');
  });

  assert.equal(await connection.userName('U404'), 'U404');
});
