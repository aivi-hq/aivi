import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AddIo, ModuleState } from '../src/add.ts';
import { add, PLUGIN_ALIASES } from '../src/add.ts';
import { pluginNames } from '../src/manifest.ts';

let directory: string;
let appDir: string;

/** A home skeleton: the server installed, the manifest npm installs against. */
beforeEach(() => {
  directory = join(tmpdir(), `aivi-add-test-${Math.random().toString(36).slice(2)}`);
  appDir = join(directory, 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'host'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'aivi-server', private: true, dependencies: {} }));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

interface Harness {
  io: AddIo;
  calls: { installs: string[]; setups: string[]; rebuilds: number; restarts: number; logs: string[] };
}

/** Mock io: nothing runs npm, the app CLI, launchd or HTTP; the fake install
 *  writes the dependency the way `npm install --save-exact` would, so the
 *  list entry lands the way the real flow leaves it. */
function harness(states: ModuleState[] = [], moduleId: string | undefined = 'discord'): Harness {
  const calls = { installs: [] as string[], setups: [] as string[], rebuilds: 0, restarts: 0, logs: [] as string[] };
  const io: AddIo = {
    install: spec => {
      calls.installs.push(spec);
      const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      const at = spec.lastIndexOf('@');
      manifest.dependencies[at > 0 ? spec.slice(0, at) : spec] = '*';
      writeFileSync(join(appDir, 'package.json'), JSON.stringify(manifest));
    },
    setupPlugin: async spec => {
      calls.setups.push(spec);
      return moduleId;
    },
    rebuildSchema: async () => {
      calls.rebuilds++;
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
    warn: message => calls.logs.push(`warn: ${message}`),
  };
  return { io, calls };
}

const options = () => ({ home: directory, appDir, nodePath: 'node' });
const RUNNING: ModuleState[] = [{ id: 'discord', state: 'running', lastError: null }];

test('add resolves aliases and runs npm, then the plugin setup, then the list and the cache', async () => {
  const { io, calls } = harness(RUNNING);
  await add(['discord'], options(), io);
  assert.deepEqual(calls.installs, ['@aivi/channel-discord']);
  assert.deepEqual(calls.setups, ['@aivi/channel-discord']);
  assert.deepEqual(pluginNames(appDir), ['@aivi/channel-discord'], 'the package name joined the list');
  assert.equal(calls.rebuilds, 1, 'the editor schema was rebuilt after the list changed');
  assert.equal(calls.restarts, 1);
  assert.match(calls.logs.at(-1)!, /Discord is running\./);
});

test('add passes an npm package through and reports it by its module id', async () => {
  const { io, calls } = harness([], 'teams');
  await add(['@acme/aivi-teams'], options(), io);
  assert.deepEqual(calls.installs, ['@acme/aivi-teams']);
  assert.deepEqual(pluginNames(appDir), ['@acme/aivi-teams']);
  assert.match(calls.logs.at(-1)!, /aivi is back and healthy/);
});

test('add skips npm when the package is already in the home, and the list stays free of doubles', async () => {
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'channel-discord'), { recursive: true });
  writeFileSync(
    join(appDir, 'node_modules', '@aivi', 'channel-discord', 'package.json'),
    JSON.stringify({ version: '0.1.0' }),
  );
  // npm writes the directory and the dependency together: a home that holds
  // the package holds its name in dependencies too.
  const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies['@aivi/channel-discord'] = '0.1.0';
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(manifest));
  const { io, calls } = harness(RUNNING);
  await add(['discord'], options(), io);
  assert.deepEqual(calls.installs, [], 'already installed: nothing fetched');
  assert.match(calls.logs[0]!, /already installed/);
  await add(['discord'], options(), io);
  assert.deepEqual(calls.setups, ['@aivi/channel-discord', '@aivi/channel-discord'], 'setup still runs');
  assert.deepEqual(pluginNames(appDir), ['@aivi/channel-discord'], 'the entry is not doubled');
});

test('add without a server home refuses before anything runs', async () => {
  rmSync(join(directory, 'app'), { recursive: true, force: true });
  const { io, calls } = harness(RUNNING);
  await assert.rejects(add(['discord'], options(), io), /aivi setup/);
  assert.deepEqual(calls.installs, []);
  assert.deepEqual(calls.setups, []);
});

test('a failed setup stops before the list, the cache and the restart', async () => {
  const { io, calls } = harness(RUNNING);
  io.setupPlugin = async spec => {
    calls.setups.push(spec);
    process.exitCode = 1;
    return undefined;
  };
  process.exitCode = undefined;
  await add(['discord'], options(), io);
  assert.deepEqual(pluginNames(appDir), [], 'a stopped flow leaves the package installed but inert');
  assert.equal(calls.rebuilds, 0);
  assert.equal(calls.restarts, 0, 'nothing was restarted');
  assert.match(calls.logs.at(-1)!, /Nothing joined the plugin list/);
  assert.equal(process.exitCode, 1);
});

test('a cache that cannot rebuild is a warning: the plugin stays listed', async () => {
  const { io, calls } = harness(RUNNING);
  io.rebuildSchema = async () => {
    throw new Error('config.json did not load');
  };
  await add(['discord'], options(), io);
  assert.deepEqual(pluginNames(appDir), ['@aivi/channel-discord']);
  assert.match(calls.logs.find(message => message.startsWith('warn: '))!, /editor schema was not rebuilt/);
  assert.equal(calls.restarts, 1, 'the plugin still joined and aivi still comes back');
});

test('add with no service installed adds nothing: the setup flow’s own last line is the last word', async () => {
  const { io, calls } = harness(RUNNING);
  io.service.installed = () => false;
  io.healthProbe = async () => false;
  await add(['discord'], options(), io);
  assert.equal(calls.restarts, 0);
  assert.ok(
    calls.logs.every(message => message.startsWith('Installing ') || message.startsWith('warn: ')),
    'the CLI says nothing after a flow that ended on its own',
  );
  assert.deepEqual(pluginNames(appDir), ['@aivi/channel-discord'], 'the list fact landed regardless');
});

test('a degraded module fails the command but says aivi keeps retrying', async () => {
  process.exitCode = undefined;
  const { io, calls } = harness([{ id: 'discord', state: 'degraded', lastError: 'Bad gateway' }]);
  await add(['discord'], options(), io);
  assert.match(calls.logs.at(-1)!, /degraded.*Bad gateway/);
  assert.equal(process.exitCode, 1);
});

test('add wants a name and refuses the server and cli themselves', async () => {
  const { io, calls } = harness(RUNNING);
  await assert.rejects(add([], options(), io), /Add what/);
  await assert.rejects(add(['--force'], options(), io), /Unknown add flag/);
  await assert.rejects(add(['@aivi/host'], options(), io), /aivi setup/);
  assert.deepEqual(calls.installs, []);
});

test('the aliases point at the shipped plugin packages', () => {
  assert.equal(PLUGIN_ALIASES.discord, '@aivi/channel-discord');
  assert.equal(PLUGIN_ALIASES.slack, '@aivi/channel-slack');
  assert.equal(PLUGIN_ALIASES.browser, '@aivi/browser');
  assert.equal(PLUGIN_ALIASES.linear, '@aivi/tracker-linear');
});
