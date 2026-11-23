import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { addPluginName, pluginNames } from '../src/manifest.ts';
import type { RemoveIo } from '../src/remove.ts';
import { remove } from '../src/remove.ts';

let directory: string;
let appDir: string;

beforeEach(() => {
  directory = join(tmpdir(), `aivi-remove-test-${Math.random().toString(36).slice(2)}`);
  appDir = join(directory, 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'host'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'aivi-server', private: true, dependencies: {} }));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

interface Harness {
  io: RemoveIo;
  calls: { blocks: string[]; uninstalls: string[]; rebuilds: number; restarts: number; logs: string[] };
}

function harness(blockRemoved = true): Harness {
  const calls = {
    blocks: [] as string[],
    uninstalls: [] as string[],
    rebuilds: 0,
    restarts: 0,
    logs: [] as string[],
  };
  const io: RemoveIo = {
    removeBlock: async name => {
      calls.blocks.push(name);
      return { moduleId: name.split('/').pop()!, blockRemoved, sectionsRemoved: 0 };
    },
    uninstall: name => {
      calls.uninstalls.push(name);
    },
    rebuildSchema: async () => {
      calls.rebuilds++;
    },
    healthUrl: async () => 'http://127.0.0.1:4100',
    healthProbe: async () => true,
    service: {
      installed: () => true,
      restart: () => {
        calls.restarts++;
      },
    },
    log: message => calls.logs.push(message),
    warn: message => calls.logs.push(`warn: ${message}`),
  };
  return { io, calls };
}

const options = () => ({ home: directory, appDir, nodePath: 'node' });

test('remove drops the block, the entry and the package, and aivi comes back without it', async () => {
  addPluginName(appDir, '@aivi/channel-discord');
  const { io, calls } = harness();
  await remove(['discord'], options(), io);
  assert.deepEqual(
    calls.blocks,
    ['@aivi/channel-discord'],
    'the block was dropped while the package could still speak',
  );
  assert.deepEqual(pluginNames(appDir), [], 'the entry left the list');
  assert.deepEqual(calls.uninstalls, ['@aivi/channel-discord']);
  assert.equal(calls.rebuilds, 1);
  assert.equal(calls.restarts, 1);
  assert.match(calls.logs.at(-1)!, /@aivi\/channel-discord is removed and aivi is back and healthy/);
});

test('remove takes a listed package name and a disabled tuple alike', async () => {
  const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  manifest['aivi-plugins'] = [['@acme/aivi-teams', false]];
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(manifest));
  const { io, calls } = harness(false);
  await remove(['@acme/aivi-teams'], options(), io);
  assert.deepEqual(pluginNames(appDir), []);
  assert.match(calls.logs.join('\n'), /out of the plugin list/);
  assert.ok(
    !calls.logs.some(message => message.includes('plugins.teams')),
    'a plugin with no block says only that the entry left',
  );
  assert.equal(calls.restarts, 1);
});

test('remove refuses what the list does not hold, and the machine parts', async () => {
  const { io, calls } = harness();
  await assert.rejects(remove(['discord'], options(), io), /not in the plugin list/);
  await assert.rejects(remove([], options(), io), /Remove what/);
  await assert.rejects(remove(['--force'], options(), io), /Unknown remove flag/);
  await assert.rejects(remove(['@aivi/host'], options(), io), /aivi uninstall/);
  assert.deepEqual(calls.blocks, []);
  assert.deepEqual(calls.uninstalls, []);
});

test('a failing npm leaves the plugin out of the list and inert, and says so', async () => {
  addPluginName(appDir, '@aivi/browser');
  const { io, calls } = harness();
  io.uninstall = () => {
    throw new Error('npm uninstall @aivi/browser failed (exit 1)');
  };
  await remove(['browser'], options(), io);
  assert.deepEqual(pluginNames(appDir), [], 'the list fact left regardless');
  assert.match(calls.logs.find(message => message.startsWith('warn: '))!, /inert/);
  assert.equal(calls.restarts, 1, 'the server comes back without the module either way');
});

test('remove with no service installed says the next serve will not run it', async () => {
  addPluginName(appDir, '@aivi/channel-discord');
  const { io, calls } = harness();
  io.service.installed = () => false;
  await remove(['discord'], options(), io);
  assert.deepEqual(pluginNames(appDir), []);
  assert.equal(calls.restarts, 0);
  assert.match(calls.logs.at(-1)!, /next `aivi serve` will not run it/);
});

test('remove finds a listed package when the name carries a version', async () => {
  addPluginName(appDir, '@acme/aivi-teams');
  const { io, calls } = harness(false);
  await remove(['@acme/aivi-teams@1.0.0'], options(), io);
  assert.deepEqual(calls.blocks, ['@acme/aivi-teams']);
  assert.deepEqual(pluginNames(appDir), []);
});

test('remove says how many sections of the plugin left the config, in the singular or the plural', async () => {
  const said: [number, RegExp][] = [
    [1, /its plugins\.discord block is gone; its 1 section under projects and projectDefaults is gone\./],
    [2, /its plugins\.discord block is gone; its 2 sections under projects and projectDefaults are gone\./],
  ];
  for (const [sectionsRemoved, line] of said) {
    addPluginName(appDir, '@aivi/channel-discord');
    const { io, calls } = harness();
    io.removeBlock = async () => ({ moduleId: 'discord', blockRemoved: true, sectionsRemoved });
    await remove(['discord'], options(), io);
    assert.match(calls.logs[0]!, line);
  }
});

test('an npm that fails with something that is not an Error is still said, and the package stays inert', async () => {
  addPluginName(appDir, '@aivi/browser');
  const { io, calls } = harness();
  io.uninstall = () => {
    throw 'npm is not on this machine';
  };
  await remove(['browser'], options(), io);
  assert.match(
    calls.logs.find(message => message.startsWith('warn: '))!,
    /^warn: npm is not on this machine — the package stays/,
  );
  assert.deepEqual(pluginNames(appDir), []);
});

test('a schema that cannot rebuild is a warning that names the usual cause, an Error or not', async () => {
  const failures: [() => Promise<void>, RegExp][] = [
    [
      async () => {
        throw new Error('config.json did not load');
      },
      /not rebuilt \(config\.json did not load\): config\.json does not load\. A section of a plugin that is no longer listed/,
    ],
    [() => Promise.reject('disk full'), /not rebuilt \(disk full\): config\.json does not load/],
  ];
  for (const [rebuildSchema, warning] of failures) {
    addPluginName(appDir, '@aivi/channel-discord');
    const { io, calls } = harness();
    io.rebuildSchema = rebuildSchema;
    await remove(['discord'], options(), io);
    assert.match(calls.logs.find(message => message.startsWith('warn: '))!, warning);
    assert.equal(calls.restarts, 1, 'the server still comes back without the module');
  }
});
