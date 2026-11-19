/** `aivi link` over its default I/O: the HTTP calls it makes to the host, the client record it reads, what it says on a
 *  terminal and the question it asks. `fetch`, the terminal and the prompt library are mocks; the record is a scratch
 *  file. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, type TestContext, test } from 'node:test';
import { aiviVersion } from '../src/version.ts';
import { override, setEnv } from './process-fixture.ts';

const CANCEL = Symbol('cancelled');
const select = mock.fn(async (_options: unknown): Promise<unknown> => 'slack');
mock.module('@clack/prompts', { exports: { select, isCancel: (value: unknown) => value === CANCEL } });
const { link } = await import('../src/link.ts');

const HOST = 'http://127.0.0.1:4100';
const TOKEN = 'aivi-test-token';
const minted = {
  code: '12345',
  expiresAt: '2026-09-22T12:34:00.000Z',
  person: 'Ada',
  next: 'In Discord, DM the bot: /link 12345.',
};
const channelsOf = (...channels: object[]) => Response.json({ channels });

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aivi-link-test-'));
  select.mock.resetCalls();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** This machine has signed in: the client record names the host and the person's token. */
function signedIn(t: TestContext): void {
  const file = join(directory, 'client.json');
  writeFileSync(file, JSON.stringify({ configVersion: 1, url: HOST, person: { token: TOKEN } }));
  setEnv(t, 'AIVI_CONFIG', file);
}

/** A host that answers the channel list on GET and the mint on POST, as the `answer` of the moment says. */
function host(t: TestContext, answer: (method: string) => Response) {
  return t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => answer(init?.method ?? 'GET'));
}

test('link, handed no I/O, lists the channels and mints a code over HTTP with the person’s bearer', async t => {
  signedIn(t);
  override(t, process.stdout, 'isTTY', false);
  const fetched = host(t, method =>
    method === 'POST' ? Response.json(minted) : channelsOf({ channel: 'discord', linked: false }),
  );
  const log = t.mock.method(console, 'log', () => {});

  await link([]);

  const headers = { 'x-aivi-client': aiviVersion, authorization: `Bearer ${TOKEN}` };
  const [list, mint] = fetched.mock.calls.map(call => call.arguments as unknown as [string, RequestInit]);
  assert.equal(list![0], `${HOST}/links`);
  assert.deepEqual(list![1].headers, headers);
  assert.ok(list![1].signal instanceof AbortSignal, 'the call is bounded');
  assert.equal(mint![0], `${HOST}/links`);
  assert.equal(mint![1].method, 'POST');
  assert.deepEqual(mint![1].headers, { ...headers, 'content-type': 'application/json' });
  assert.equal(mint![1].body, JSON.stringify({ channel: 'discord' }));
  assert.deepEqual(JSON.parse(log.mock.calls[0]!.arguments[0]), { ...minted, channel: 'discord' });
});

test('link, handed no I/O, says why the host could not list or mint', async t => {
  signedIn(t);
  const channels = () => channelsOf({ channel: 'discord', linked: false });
  let answer: (method: string) => Response = () => new Response('');
  host(t, method => answer(method));
  const refusals: [string, (method: string) => Response, string][] = [
    [
      'the list is refused',
      () => new Response('', { status: 503 }),
      'Listing the channels aivi runs failed: HTTP 503.',
    ],
    [
      'the person is already linked there',
      method => (method === 'POST' ? new Response('', { status: 409 }) : channels()),
      'Already linked in the discord channel.',
    ],
    [
      'the channel is not running',
      method => (method === 'POST' ? new Response('', { status: 404 }) : channels()),
      'No channel module "discord" is running.',
    ],
    [
      'the mint fails',
      method => (method === 'POST' ? new Response('', { status: 500 }) : channels()),
      'Minting a link code failed: HTTP 500.',
    ],
  ];

  for (const [what, respond, message] of refusals) {
    answer = respond;
    await assert.rejects(link([]), { message }, what);
  }
});

test('link, handed no I/O, reads a host that lists no channels as a host with none', async t => {
  signedIn(t);
  override(t, process.stdout, 'isTTY', false);
  const fetched = host(t, () => Response.json({}));
  const log = t.mock.method(console, 'log', () => {});

  await link([]);

  assert.deepEqual(JSON.parse(log.mock.calls[0]!.arguments[0]), { channels: [] });
  assert.equal(fetched.mock.callCount(), 1, 'nothing was minted');
});

test('link, handed no I/O, says one sentence on a terminal where a pipe gets the JSON', async t => {
  signedIn(t);
  override(t, process.stdout, 'isTTY', true);
  let answer: (method: string) => Response = () => channelsOf();
  host(t, method => answer(method));
  const log = t.mock.method(console, 'log', () => {});
  const sentences: [string[], (method: string) => Response, RegExp][] = [
    [[], () => channelsOf(), /^No channel module is running yet\. Start aivi, then run aivi link again\.$/],
    [[], () => channelsOf({ channel: 'discord', linked: true }), /^Already linked everywhere aivi runs: discord\.$/],
    [['Discord'], () => channelsOf({ channel: 'discord', linked: true }), /^Already linked in the discord channel\.$/],
    [
      ['discord'],
      method => (method === 'POST' ? Response.json(minted) : channelsOf({ channel: 'discord', linked: false })),
      /^In Discord, DM the bot: \/link 12345\. {2}— {2}expires \S+/,
    ],
  ];

  for (const [args, respond, sentence] of sentences) {
    answer = respond;
    await link(args);
    assert.match(log.mock.calls.at(-1)!.arguments[0], sentence);
  }
});

test('link, handed no I/O, asks which channel on a terminal, and refuses to guess without one', async t => {
  signedIn(t);
  override(t, process.stdout, 'isTTY', false);
  override(t, process.stdin, 'isTTY', false);
  const hint = 'In Slack, run /x-link <code> anywhere.';
  const fetched = host(t, method =>
    method === 'POST'
      ? Response.json(minted)
      : channelsOf({ channel: 'discord', linked: false }, { channel: 'slack', hint, linked: false }),
  );
  t.mock.method(console, 'log', () => {});

  await assert.rejects(link([]), { message: 'Several channels are eligible; name one: aivi link discord|slack' });
  assert.equal(select.mock.callCount(), 0, 'no terminal, no question');

  process.stdin.isTTY = true;
  await link([]);
  assert.deepEqual(select.mock.calls[0]!.arguments[0], {
    message: 'Where will you use the code?',
    options: [{ value: 'discord' }, { value: 'slack', hint }],
  });
  assert.equal(fetched.mock.calls.at(-1)!.arguments[1]!.body, JSON.stringify({ channel: 'slack' }));

  select.mock.mockImplementationOnce(async () => CANCEL);
  await assert.rejects(link([]), { message: 'No channel chosen; nothing was linked.' });
});

test('link, handed no I/O, finds the client record where the platform keeps it', async t => {
  override(t, process.stdout, 'isTTY', false);
  host(t, () => channelsOf());
  const log = t.mock.method(console, 'log', () => {});
  setEnv(t, 'AIVI_CONFIG', undefined);
  setEnv(t, 'XDG_CONFIG_HOME', undefined);
  setEnv(t, 'HOME', undefined);
  const record = JSON.stringify({ configVersion: 1, url: HOST, person: { token: TOKEN } });
  const kept: [string, () => string][] = [
    [
      'under XDG_CONFIG_HOME',
      () => {
        process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
        return 'xdg';
      },
    ],
    [
      'under HOME, in .config',
      () => {
        delete process.env.XDG_CONFIG_HOME;
        process.env.HOME = join(directory, 'home');
        return join('home', '.config');
      },
    ],
  ];

  for (const [where, place] of kept) {
    const base = place();
    mkdirSync(join(directory, base, 'aivi'), { recursive: true });
    writeFileSync(join(directory, base, 'aivi', 'config.json'), record);
    await link([]);
    assert.deepEqual(JSON.parse(log.mock.calls.at(-1)!.arguments[0]), { channels: [] }, `signed in ${where}`);
  }
});

test('link, handed no I/O, asks for a sign-in first when the record is missing, unreadable or incomplete', async t => {
  const file = join(directory, 'client.json');
  setEnv(t, 'AIVI_CONFIG', file);
  setEnv(t, 'XDG_CONFIG_HOME', undefined);
  setEnv(t, 'HOME', undefined);
  const refusal = { message: 'This machine has not signed in. Run `aivi setup` first; linking names a person.' };
  const records: [string, string | undefined][] = [
    ['no record', undefined],
    ['a record that is not JSON', 'not json'],
    ['a record with no host', JSON.stringify({ configVersion: 1, person: { token: TOKEN } })],
    ['a record with no person', JSON.stringify({ configVersion: 1, url: HOST })],
  ];

  for (const [what, bytes] of records) {
    rmSync(file, { force: true });
    if (bytes !== undefined) writeFileSync(file, bytes);
    await assert.rejects(link([]), refusal, what);
  }

  delete process.env.AIVI_CONFIG; // and with no home to look in, the record is looked for under the working directory
  await assert.rejects(link([]), refusal, 'no AIVI_CONFIG, no XDG_CONFIG_HOME, no HOME');
});

test('link wants at most one platform name', async () => {
  await assert.rejects(link(['discord', 'slack']), { message: 'Usage: aivi link [PLATFORM]' });
});
