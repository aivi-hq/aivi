import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { clientConfigSchema, loadClientConfig, saveClientConfig } from '../src/client-config.ts';
import { appCliPath, forward } from '../src/forward.ts';
import type { SetupIo } from '../src/setup.ts';
import { extractSetupFlags, seedHomeOpenCode, setup } from '../src/setup.ts';

let directory: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtemp();
  savedEnv = { AIVI_HOME: process.env.AIVI_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  delete process.env.AIVI_HOME;
  process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = undefined;
  rmSync(directory, { recursive: true, force: true });
});

function mkdtemp(): string {
  return join(tmpdir(), `aivi-cli-test-${Math.random().toString(36).slice(2)}`);
}

const TOKEN = `aivi-${'a'.repeat(32)}`;

/** Deterministic answers instead of prompts, so a test runs the same on a TTY
 *  and in a pipe; every ask throws until a test needs it. */
function fakeIo(overrides: Partial<SetupIo> = {}): {
  io: SetupIo;
  calls: {
    installs: string[][];
    plugins: string[];
    identity: string[][];
    logs: string[];
  };
} {
  const calls = {
    installs: [] as string[][],
    plugins: [] as string[],
    identity: [] as string[][],
    logs: [] as string[],
  };
  const io: SetupIo = {
    install: specs => calls.installs.push(specs),
    npmView: async () => '9.9.9',
    forwardIdentity: (args, home) => {
      calls.identity.push(args);
      return { home, url: 'http://127.0.0.1:4100', person: 'person-1234abcd', name: 'Ada', token: TOKEN };
    },
    opencodeOnPath: () => true,
    pluginAdd: pkg => calls.plugins.push(pkg),
    health: async () => true,
    whoami: async () => ({ person: { id: 'person-1234abcd', name: 'Ada' }, roles: ['operator'] }),
    serviceInstall: () => {
      throw new Error('service install must not run in these tests');
    },
    ask: {
      branch: async () => 'connect',
      machine: async () => 'this-machine',
      background: async () => false,
      name: async () => 'Ada',
      url: async () => 'http://127.0.0.1:4100',
      token: async () => TOKEN,
    },
    log: message => calls.logs.push(message),
    warn: () => {},
    ...overrides,
  };
  return { io, calls };
}

test('the published bin starts with a shebang, or the global command cannot execute', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node'), 'bin entry points at this file: it needs a shebang');
});

test('the client config saves 0600, preserves unknown fields and never drops the person', () => {
  const path = join(directory, 'xdg', 'aivi.json');
  saveClientConfig({ home: '/home/me/.aivi', appDir: '/home/me/.aivi/app', installMethod: 'npm' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  saveClientConfig({ url: 'http://127.0.0.1:4100', person: { token: 'aivi-t' } });
  const loaded = loadClientConfig()!;
  assert.equal(loaded.home, '/home/me/.aivi');
  assert.equal(loaded.person?.token, 'aivi-t');
  assert.equal(loaded.installMethod, 'npm');
  assert.equal(loaded.configVersion, 1);
});

test('unknown fields survive a save', () => {
  const path = join(directory, 'xdg', 'aivi.json');
  mkdirSync(join(directory, 'xdg'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ configVersion: 1, future: { deep: true } }, null, 2)}\n`);
  saveClientConfig({ home: '/h' });
  assert.deepEqual(clientConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).future, { deep: true });
});

test('setup flags are pulled out; unknown flags are refused', () => {
  const flags = extractSetupFlags([
    '--plugin',
    '@aivi/channel-discord',
    '--app-spec',
    '@aivi/app@0.2.0',
    '--use',
    'this-machine',
    '--name',
    'Ada',
  ]);
  assert.deepEqual(flags.plugins, ['@aivi/channel-discord']);
  assert.equal(flags.appSpec, '@aivi/app@0.2.0');
  assert.equal(flags.use, 'this-machine');
  assert.equal(flags.name, 'Ada');
  assert.equal(flags.connect, false);
  const equals = extractSetupFlags(['--connect', '--url=http://h:1', '--token=t']);
  assert.equal(equals.connect, true);
  assert.equal(equals.url, 'http://h:1');
  assert.equal(equals.token, 't');
  assert.throws(() => extractSetupFlags(['--wat']), /Unknown setup flag/);
  assert.throws(() => extractSetupFlags(['--url']), /wants a value/);
});

test('setup --connect verifies before writing and caches the person', async () => {
  const { io, calls } = fakeIo();
  await setup(['--connect', '--url', 'http://127.0.0.1:4100', '--token', TOKEN], { home: join(directory, 'home') }, io);
  const record = loadClientConfig()!;
  assert.equal(record.url, 'http://127.0.0.1:4100');
  assert.deepEqual(record.person, { token: TOKEN, id: 'person-1234abcd', name: 'Ada', roles: ['operator'] });
  assert.deepEqual(calls.plugins, ['@aivi/opencode', 'opencode-attribution']);
  assert.deepEqual(calls.installs, [], 'connecting installs nothing');
  assert.match(calls.logs.at(-1)!, /Signed in as Ada/);
});

test('setup --connect refuses an unreachable host and persists nothing', async () => {
  const { io, calls } = fakeIo({ health: async () => false });
  await assert.rejects(
    setup(['--connect', '--url', 'http://127.0.0.1:1', '--token', TOKEN], { home: join(directory, 'home') }, io),
    /No answer from/,
  );
  assert.equal(loadClientConfig(), undefined, 'nothing was written');
  assert.deepEqual(calls.plugins, []);
});

test('setup creates the home, seeds OpenCode and signs this machine in', async () => {
  const home = join(directory, 'home');
  const { io, calls } = fakeIo();
  await setup(['--use', 'this-machine', '--name', 'Ada'], { home }, io);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { version: 1 });
  assert.equal(existsSync(join(home, '.env')), true);
  assert.equal(existsSync(join(home, 'app', '.npmrc')), true);
  assert.deepEqual(calls.installs, [['@aivi/app']]);
  assert.deepEqual(calls.identity, [['--use', 'this-machine', '--name', 'Ada']]);
  const jsonc = readFileSync(join(home, 'opencode.jsonc'), 'utf8');
  assert.match(jsonc, /"@aivi\/opencode@9\.9\.9"/);
  for (const agent of ['aivi.md', 'librarian.md', 'dreamer.md'])
    assert.equal(existsSync(join(home, '.opencode', 'agents', agent)), true, agent);
  const record = loadClientConfig()!;
  assert.equal(record.home, home);
  assert.equal(record.appDir, join(home, 'app'));
  assert.equal(record.installMethod, 'npm');
  assert.equal(record.person?.token, TOKEN, 'the non-background path still signs this machine in');
  assert.deepEqual(calls.plugins, ['@aivi/opencode', 'opencode-attribution']);
  assert.equal(calls.logs.filter(line => line.includes('`aivi serve`')).length, 1, 'the next step is said once');
});

test('setup for a headless server prints the handoff and signs nobody in', async () => {
  const home = join(directory, 'home');
  const { io, calls } = fakeIo();
  await setup(['--use', 'another', '--name', 'Ada'], { home }, io);
  const handoff = calls.logs.join('\n');
  assert.match(handoff, /http:\/\/127\.0\.0\.1:4100/);
  assert.match(handoff, new RegExp(TOKEN));
  assert.match(handoff, /Connect to a host/);
  assert.deepEqual(calls.plugins, [], 'nothing is installed on the server for a remote client');
  assert.equal(loadClientConfig()!.person, undefined, 'no person signs in here');
});

test('a server on this machine without a sign-in connects to its own host', async () => {
  const home = join(directory, 'home');
  mkdirSync(join(home, 'app', 'node_modules', '@aivi', 'app'), { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1 }));
  const { io, calls } = fakeIo();
  await setup([], { home }, io);
  const record = loadClientConfig()!;
  assert.equal(record.url, 'http://127.0.0.1:4100', 'the url comes from the home, only the token is asked');
  assert.equal(record.home, undefined, 'the installation record is not rewritten');
  assert.deepEqual(calls.installs, [], 'an installed server is not installed again');
  assert.match(calls.logs.at(-1)!, /Signed in as Ada/);
});

test('a signed-in machine is verified and the person cache is refreshed', async () => {
  saveClientConfig({ url: 'http://127.0.0.1:4100', person: { token: TOKEN } });
  const { io, calls } = fakeIo();
  await setup([], { home: join(directory, 'home') }, io);
  const record = loadClientConfig()!;
  assert.deepEqual(record.person, { token: TOKEN, id: 'person-1234abcd', name: 'Ada', roles: ['operator'] });
  assert.match(calls.logs.at(-1)!, /Signed in as Ada/);
});

test('--connect and --use choose different branches; giving both is refused', async () => {
  const { io } = fakeIo();
  await assert.rejects(
    setup(['--connect', '--use', 'this-machine'], { home: join(directory, 'home') }, io),
    /different branches/,
  );
});

test('seeding the home keeps what exists and fills only the gaps', () => {
  const home = join(directory, 'home');
  mkdirSync(join(home, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(home, 'opencode.jsonc'), '{"kept":true}');
  writeFileSync(join(home, '.opencode', 'agents', 'librarian.md'), 'custom');
  seedHomeOpenCode(home, '@aivi/opencode@1.0.0');
  assert.equal(readFileSync(join(home, 'opencode.jsonc'), 'utf8'), '{"kept":true}');
  assert.equal(readFileSync(join(home, '.opencode', 'agents', 'librarian.md'), 'utf8'), 'custom');
  assert.equal(existsSync(join(home, '.opencode', 'agents', 'aivi.md')), true, 'missing agents are added');
});

test('forwarding runs the installed app CLI with AIVI_HOME and passes argv through', () => {
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  assert.throws(() => appCliPath(appDir), /No aivi server installed/);
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'app', 'dist'), { recursive: true });
  const marker = join(directory, 'marker.json');
  writeFileSync(
    join(appDir, 'node_modules', '@aivi', 'app', 'dist', 'cli.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({argv: process.argv.slice(2), home: process.env.AIVI_HOME}));\n`,
  );
  const status = forward(['jobs', 'list'], { home, appDir });
  assert.equal(status, 0);
  const seen = JSON.parse(readFileSync(marker, 'utf8')) as { argv: string[]; home: string };
  assert.deepEqual(seen.argv, ['jobs', 'list']);
  assert.equal(seen.home, home);
});
