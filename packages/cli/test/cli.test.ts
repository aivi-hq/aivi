import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { clientConfigSchema, loadClientConfig, saveClientConfig } from '../src/client-config.ts';
import { extractCreateFlags, serverCreate } from '../src/create.ts';
import { appCliPath, forward } from '../src/forward.ts';

let directory: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aivi-cli-test-'));
  savedEnv = { AIVI_HOME: process.env.AIVI_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  delete process.env.AIVI_HOME;
  process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

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

test('create flags are pulled out; everything else forwards verbatim', () => {
  const flags = extractCreateFlags([
    '--plugin',
    '@aivi/channel-discord',
    '--use=this-machine',
    '--app-spec',
    '@aivi/app@0.2.0',
    '--name',
    'Ada',
  ]);
  assert.deepEqual(flags.plugins, ['@aivi/channel-discord']);
  assert.equal(flags.appSpec, '@aivi/app@0.2.0');
  assert.deepEqual(flags.forwarded, ['--use=this-machine', '--name', 'Ada']);
});

test('server create writes the home, installs server plus plugins, records and forwards', () => {
  const home = join(directory, 'home');
  const installs: string[][] = [];
  const forwarded: string[][] = [];
  const io = {
    install: (specs: string[]) => {
      installs.push(specs);
    },
    forwardIdentity: (args: string[]) => {
      forwarded.push(args);
    },
    log: () => {},
  };
  serverCreate(['--plugin', '@aivi/channel-discord', '--use', 'this-machine', '--name', 'Ada'], { home }, io);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')), { version: 1 });
  assert.equal(existsSync(join(home, '.env')), true);
  assert.equal(existsSync(join(home, 'app', '.npmrc')), true);
  assert.deepEqual(installs, [['@aivi/app', '@aivi/channel-discord']]);
  assert.deepEqual(forwarded, [['--use', 'this-machine', '--name', 'Ada']]);
  const record = clientConfigSchema.parse(JSON.parse(readFileSync(join(directory, 'xdg', 'aivi.json'), 'utf8')));
  assert.equal(record.home, home);
  assert.equal(record.appDir, join(home, 'app'));
  assert.equal(record.installMethod, 'npm');
  assert.equal(record.nodePath, process.execPath);
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
