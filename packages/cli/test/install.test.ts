import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { InstallIo, ModuleState } from '../src/install.ts';
import { install, PLUGIN_ALIASES } from '../src/install.ts';

let directory: string;

beforeEach(() => {
  directory = join(tmpdir(), `aivi-install-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(directory, 'app', 'node_modules', '@aivi', 'app'), { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

interface Harness {
  io: InstallIo;
  calls: { installs: string[]; forwards: string[][]; restarts: number; logs: string[] };
}

/** Mock io: nothing runs npm, the app CLI, launchd or HTTP; the server is
 *  always reachable and reports the module states a test sets. */
function harness(states: ModuleState[] = []): Harness {
  const calls = { installs: [] as string[], forwards: [] as string[][], restarts: 0, logs: [] as string[] };
  const io: InstallIo = {
    install: spec => calls.installs.push(spec),
    forwardSetup: spec => {
      calls.forwards.push(['plugin', 'setup', spec]);
      return 0;
    },
    healthUrl: async () => 'http://127.0.0.1:4100',
    healthProbe: async () => true,
    moduleStates: async () => states,
    service: {
      installed: () => true,
      stop: () => {},
      start: () => {
        calls.restarts++;
      },
    },
    log: message => calls.logs.push(message),
  };
  return { io, calls };
}

const RUNNING: ModuleState[] = [{ id: 'discord', state: 'running', lastError: null }];

test('install resolves aliases and runs npm, then the plugin setup', async () => {
  const { io, calls } = harness(RUNNING);
  await install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io);
  assert.deepEqual(calls.installs, ['@aivi/channel-discord']);
  assert.deepEqual(calls.forwards, [['plugin', 'setup', '@aivi/channel-discord']]);
  assert.equal(calls.restarts, 1);
  assert.match(calls.logs.at(-1)!, /Discord is running\./);
});

test('install passes an npm spec through and reports it by its own name', async () => {
  const { io, calls } = harness([]);
  await install(['@acme/aivi-teams'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io);
  assert.deepEqual(calls.installs, ['@acme/aivi-teams']);
  assert.deepEqual(calls.forwards, [['plugin', 'setup', '@acme/aivi-teams']]);
  assert.match(calls.logs.at(-1)!, /aivi is back and healthy/);
});

test('install skips npm when the package is already in the home', async () => {
  mkdirSync(join(directory, 'app', 'node_modules', '@aivi', 'channel-discord'), { recursive: true });
  writeFileSync(
    join(directory, 'app', 'node_modules', '@aivi', 'channel-discord', 'package.json'),
    JSON.stringify({ version: '0.1.0' }),
  );
  const { io, calls } = harness(RUNNING);
  await install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io);
  assert.deepEqual(calls.installs, [], 'already installed: nothing fetched');
  assert.match(calls.logs[0]!, /already installed/);
  assert.deepEqual(calls.forwards, [['plugin', 'setup', '@aivi/channel-discord']], 'setup still runs');
});

test('install without a server home refuses before anything runs', async () => {
  rmSync(join(directory, 'app'), { recursive: true, force: true });
  const { io, calls } = harness(RUNNING);
  await assert.rejects(
    install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io),
    /aivi setup/,
  );
  assert.deepEqual(calls.installs, []);
  assert.deepEqual(calls.forwards, []);
});

test('a failed setup stops before the restart', async () => {
  const { io, calls } = harness(RUNNING);
  io.forwardSetup = () => {
    calls.forwards.push([]);
    return 1;
  };
  process.exitCode = undefined;
  await install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io);
  assert.equal(calls.restarts, 0, 'nothing was restarted');
  assert.match(calls.logs.at(-1)!, /Nothing was restarted/);
  assert.equal(process.exitCode, 1);
});

test('install without a service says how aivi comes up; a foreground server is the operator’s', async () => {
  const { io, calls } = harness(RUNNING);
  io.service.installed = () => false;
  io.healthProbe = async () => false;
  await install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io);
  assert.equal(calls.restarts, 0);
  assert.match(calls.logs.at(-1)!, /Start aivi to bring Discord up/);

  const foreground = harness(RUNNING);
  foreground.io.service.installed = () => false;
  foreground.io.healthProbe = async () => true;
  await install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, foreground.io);
  assert.match(foreground.calls.logs.at(-1)!, /Ctrl\+C/);
});

test('a degraded module fails the command but says aivi keeps retrying', async () => {
  process.exitCode = undefined;
  const { io, calls } = harness([{ id: 'discord', state: 'degraded', lastError: 'Bad gateway' }]);
  await install(['discord'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io);
  assert.match(calls.logs.at(-1)!, /degraded.*Bad gateway/);
  assert.equal(process.exitCode, 1);
});

test('install wants a name and refuses the server and cli themselves', async () => {
  const { io, calls } = harness(RUNNING);
  await assert.rejects(
    install([], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io),
    /Install what/,
  );
  await assert.rejects(
    install(['--force'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io),
    /Unknown install flag/,
  );
  await assert.rejects(
    install(['@aivi/app'], { home: directory, appDir: join(directory, 'app'), nodePath: 'node' }, io),
    /aivi setup/,
  );
  assert.deepEqual(calls.installs, []);
});

test('the aliases point at the shipped channel packages', () => {
  assert.equal(PLUGIN_ALIASES.discord, '@aivi/channel-discord');
  assert.equal(PLUGIN_ALIASES.slack, '@aivi/channel-slack');
});
