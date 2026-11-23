import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { clientConfigSchema, loadClientConfig, saveClientConfig } from '../src/client-config.ts';
import { extractLinkArgs, link } from '../src/link.ts';

let directory: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtemp();
  savedEnv = {
    AIVI_CONFIG: process.env.AIVI_CONFIG,
    AIVI_HOME: process.env.AIVI_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  delete process.env.AIVI_CONFIG;
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

test('the published bin starts with a shebang, or the global command cannot execute', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node'), 'bin entry points at this file: it needs a shebang');
});

test('the client config saves 0600, preserves unknown fields and never drops the person', () => {
  const path = join(directory, 'xdg', 'aivi', 'config.json');
  saveClientConfig({ home: '/home/me/.aivi', appDir: '/home/me/.aivi/app', installMethod: 'npm' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  saveClientConfig({ url: 'http://127.0.0.1:4100', person: { token: 'aivi-t' } });
  const loaded = loadClientConfig()!;
  assert.equal(loaded.home, '/home/me/.aivi');
  assert.equal(loaded.person?.token, 'aivi-t');
  assert.equal(loaded.installMethod, 'npm');
  assert.equal(loaded.configVersion, 1);
});

test('AIVI_CONFIG moves the whole client record, leading over XDG_CONFIG_HOME', () => {
  saveClientConfig({ home: '/dev/home', appDir: '/dev/home/app' });
  assert.ok(existsSync(join(directory, 'xdg', 'aivi', 'config.json')), 'without AIVI_CONFIG the xdg path is used');
  process.env.AIVI_CONFIG = join(directory, 'dev.json');
  assert.equal(loadClientConfig(), undefined, 'the overridden path starts empty');
  saveClientConfig({ home: '/dev/other' });
  assert.deepEqual(loadClientConfig()!.home, '/dev/other');
  assert.equal(existsSync(join(directory, 'dev.json')), true);
  assert.equal(existsSync(join(directory, 'xdg', 'aivi', 'config.json')), true, 'the previous record is untouched');
});

test('unknown fields survive a save', () => {
  const path = join(directory, 'xdg', 'aivi', 'config.json');
  mkdirSync(join(directory, 'xdg', 'aivi'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ configVersion: 1, future: { deep: true } }, null, 2)}\n`);
  saveClientConfig({ home: '/h' });
  assert.deepEqual(clientConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).future, { deep: true });
});

test('aivi link mints a code over HTTP and says exactly where to spend it', async () => {
  saveClientConfig({ url: 'http://127.0.0.1:4100', person: { token: TOKEN } });
  const mints: [string, string, string][] = [];
  const logs: string[] = [];
  await link(['discord'], {
    channels: async () => [{ channel: 'discord', hint: 'In Discord, DM the bot: /link <code>.', linked: false }],
    mint: async (url, token, channel) => {
      mints.push([url, token, channel]);
      return {
        code: '12345',
        expiresAt: '2026-09-22T12:34:00.000Z',
        person: 'Ada',
        next: 'In Discord, DM the bot: /link 12345.',
      };
    },
    askPlatform: async () => {
      throw new Error('no prompt expected');
    },
    log: message => logs.push(message),
  });
  assert.deepEqual(mints, [['http://127.0.0.1:4100', TOKEN, 'discord']]);
  const out = JSON.parse(logs[0]!) as { code: string; channel: string; next: string };
  assert.equal(out.code, '12345');
  assert.equal(out.channel, 'discord');
  assert.match(out.next, /\/link 12345/, 'the instruction carries the code itself');
});

test('aivi link asks which eligible channel when several run, and refuses an unknown one', async () => {
  saveClientConfig({ url: 'http://127.0.0.1:4100', person: { token: TOKEN } });
  const logs: string[] = [];
  await link([], {
    channels: async () => [
      { channel: 'discord', linked: false },
      { channel: 'slack', hint: 'In Slack, run /{prefix}-link <code> anywhere.', linked: false },
      { channel: 'elsewhere', linked: true },
    ],
    mint: async (_url, _token, channel) => ({
      code: '54321',
      expiresAt: '2026-09-22T12:34:00.000Z',
      person: 'Ada',
      next: `Paste \`/link 54321\` in the ${channel} channel the bot reads.`,
    }),
    askPlatform: async channels => {
      assert.deepEqual(
        channels.map(c => c.channel),
        ['discord', 'slack'],
        'the prompt offers the running channels this person is not linked in yet',
      );
      return 'slack';
    },
    log: (message: string) => logs.push(message),
  });
  const out = JSON.parse(logs[0]!) as { channel: string; next: string };
  assert.equal(out.channel, 'slack');
  assert.match(out.next, /54321/);
  await assert.rejects(
    link(['teams'], {
      channels: async () => [{ channel: 'discord', linked: false }],
      mint: async () => ({ code: '1', expiresAt: '', person: '', next: '' }),
      askPlatform: async () => 'discord',
      log: () => {},
    }),
    /No channel module "teams"/,
  );
});

test('aivi link declines without minting: nothing running, or already linked', async () => {
  saveClientConfig({ url: 'http://127.0.0.1:4100', person: { token: TOKEN } });
  const mints: string[] = [];
  const mint = async (_url: string, _token: string, channel: string) => {
    mints.push(channel);
    return { code: '1', expiresAt: '', person: '', next: '' };
  };
  const logs: string[] = [];
  const noPrompt = async (): Promise<string> => {
    throw new Error('no prompt expected');
  };
  // Nothing is running: a code no module could read is never minted.
  await link([], { channels: async () => [], mint, askPlatform: noPrompt, log: message => logs.push(message) });
  assert.deepEqual(mints, []);
  assert.deepEqual(JSON.parse(logs.at(-1)!), { channels: [] });
  // The named channel is already this person's: the CLI asks first, so no code
  // is even requested.
  await link(['discord'], {
    channels: async () => [{ channel: 'discord', linked: true }],
    mint,
    askPlatform: noPrompt,
    log: message => logs.push(message),
  });
  assert.deepEqual(mints, [], 'no second code for a channel the person is linked in');
  assert.deepEqual(JSON.parse(logs.at(-1)!), { channel: 'discord', linked: true });
  // Unnamed with every running channel linked: the same refusal, no code.
  await link([], {
    channels: async () => [{ channel: 'discord', linked: true }],
    mint,
    askPlatform: noPrompt,
    log: message => logs.push(message),
  });
  assert.deepEqual(mints, []);
  assert.equal((JSON.parse(logs.at(-1)!) as { channels: { linked: boolean }[] }).channels[0]!.linked, true);
});

test('aivi link without a sign-in says what to run first', async () => {
  await assert.rejects(
    link([], {
      channels: async () => {
        throw new Error('must not reach the host');
      },
      mint: async () => {
        throw new Error('must not reach the host');
      },
      askPlatform: async () => 'discord',
      log: () => {},
    }),
    /aivi setup/,
  );
  assert.throws(() => extractLinkArgs(['a', 'b']), /Usage/);
});

/** A fake installed server: an ESM `dist/cli.js` the CLI can import. */
function fakeInstalledApp(home: string, body: string): void {
  const pkg = join(home, 'app', 'node_modules', '@aivi', 'host');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@aivi/host', type: 'module' }));
  writeFileSync(join(pkg, 'dist', 'cli.js'), body);
}

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));

/** Run the real CLI entry against this test's home. */
const runCli = (...args: string[]) =>
  spawnSync(process.execPath, [mainPath, ...args], { encoding: 'utf8', env: process.env });

test('an operator command runs in the installed app’s code, in-process, with the CLI’s home', () => {
  const home = join(directory, 'home');
  const marker = join(directory, 'marker.json');
  fakeInstalledApp(
    home,
    `import { writeFileSync } from 'node:fs';
export const registerCommands = program => {
  program
    .command('jobs')
    .command('list')
    .action(() => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ home: process.env.AIVI_HOME })));
};
`,
  );
  process.env.AIVI_HOME = home;
  const run = runCli('jobs', 'list');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).home, home, 'the app code sees the home the CLI resolved');
});

test('without an installed app an operator command says what to run, and help still shows the machine commands', () => {
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  process.env.AIVI_HOME = home;
  const run = runCli('jobs', 'list');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No aivi server installed at .* Run `aivi setup` first/);
  const help = runCli('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /aivi setup/);
  assert.match(help.stdout, /App commands unavailable/, 'the missing install is said, not hidden');
});

test('a broken app install cannot hide the machine commands nor stop the machine commands', () => {
  const home = join(directory, 'home');
  fakeInstalledApp(home, "throw new Error('half-installed');\n");
  process.env.AIVI_HOME = home;
  const help = runCli('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /half-installed/);
  const version = runCli('version');
  assert.equal(version.status, 0, 'a machine command never imports the app');
});
