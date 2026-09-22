import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { clientConfigPath, saveClientConfig } from '../src/client-config.ts';
import { serviceUnitPath } from '../src/service.ts';
import { AIVI_PLUGIN, ATTRIBUTION_PLUGIN } from '../src/setup.ts';
import type { UninstallIo } from '../src/uninstall.ts';
import { uninstall } from '../src/uninstall.ts';

let directory: string;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = join(tmpdir(), `aivi-uninstall-test-${Math.random().toString(36).slice(2)}`);
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

/** Nothing here touches a real file unless a test asks for it: the only effects
 *  a fake records are the order things happened in. */
function fakeIo(over: Partial<UninstallIo> = {}): { io: UninstallIo; calls: Calls } {
  const calls: Calls = {
    order: [],
    removed: [],
    plugins: [],
    logs: [],
    warns: [],
  };
  const io: UninstallIo = {
    exists: () => false,
    remove: path => {
      calls.order.push('remove');
      calls.removed.push(path);
    },
    async health() {
      return false;
    },
    service: {
      installed: () => false,
      uninstall: () => calls.order.push('service'),
    },
    opencodeOnPath: () => false,
    pluginList: () => '',
    pluginRemove: pkg => {
      calls.order.push('plugin');
      calls.plugins.push(pkg);
    },
    detectMethod: () => undefined,
    selfDelete: method => calls.order.push(`self:${method}`),
    log: message => calls.logs.push(message),
    warn: message => calls.warns.push(message),
    ...over,
  };
  return { io, calls };
}

interface Calls {
  order: string[];
  removed: string[];
  plugins: string[];
  logs: string[];
  warns: string[];
}

const homeOf = () => join(directory, 'home');
const configOf = (home: string) => join(home, 'config.json');

test('without --confirm it lists the absolute paths and deletes nothing', async () => {
  const home = homeOf();
  saveClientConfig({ home });
  const { io, calls } = fakeIo({ exists: path => path === configOf(home) || path === clientConfigPath() });
  const done = await uninstall({ home, confirm: false, withAttribution: false }, io);
  assert.equal(done, false, 'a dry run stops short, so the CLI exits non-zero');
  assert.deepEqual(calls.removed, [], 'nothing was deleted');
  const out = calls.logs.join('\n');
  assert.match(out, new RegExp(`^  ${home} {2}the aivi home$`, 'm'), 'the home is named whole');
  assert.match(out, new RegExp(`  ${clientConfigPath()} {2}the client config`, 'm'));
  assert.match(out, /Nothing deleted\. Re-run with --confirm/);
});

test('--confirm deletes the home and the client config, the service before them', async () => {
  const home = homeOf();
  const unit = serviceUnitPath();
  const present = new Set([configOf(home), clientConfigPath(), ...(unit ? [unit] : [])]);
  const { io, calls } = fakeIo({
    exists: path => present.has(path),
    detectMethod: () => 'npm',
    service: { installed: () => true, uninstall: () => calls.order.push('service') },
  });
  assert.equal(await uninstall({ home, confirm: true, withAttribution: false }, io), true);
  assert.deepEqual(calls.removed, [home, clientConfigPath()]);
  assert.deepEqual(
    calls.order,
    ['service', 'remove', 'remove', 'self:npm'],
    'a unit whose server is gone would be relaunched forever',
  );
  assert.match(calls.logs.join('\n'), /the last thing it says/);
});

test('a path with no config.json in it is refused, and nothing goes', async () => {
  const { io, calls } = fakeIo({ detectMethod: () => 'npm' });
  await assert.rejects(
    uninstall({ home: homeOf(), confirm: true, withAttribution: false }, io),
    /No config.json at .* so aivi deletes nothing/,
  );
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(calls.order, [], 'not even the CLI removed itself');
});

test('the root of the machine and the user home are never an aivi home', async () => {
  const { io, calls } = fakeIo({ exists: () => true, detectMethod: () => 'npm' });
  for (const path of ['/', homedir()])
    await assert.rejects(uninstall({ home: path, confirm: true, withAttribution: false }, io), /is not a directory/);
  assert.deepEqual(calls.removed, []);
});

test('a server running in the foreground is the person to stop', async () => {
  const home = homeOf();
  const { io, calls } = fakeIo({ exists: path => path === configOf(home), health: async () => true });
  await assert.rejects(
    uninstall({ home, confirm: true, withAttribution: false }, io),
    /running in the foreground; stop it/,
  );
  assert.deepEqual(calls.removed, []);
});

test('the attribution plugin stays until it is asked for; aivi is always removed', async () => {
  const home = homeOf();
  const listed = `ID  VERSION  SOURCE\n-  -  ${AIVI_PLUGIN}\n${ATTRIBUTION_PLUGIN}  0.2.0  ${ATTRIBUTION_PLUGIN}`;
  const kept = fakeIo({
    exists: path => path === configOf(home),
    opencodeOnPath: () => true,
    pluginList: () => listed,
    detectMethod: () => 'npm',
  });
  await uninstall({ home, confirm: true, withAttribution: false }, kept.io);
  assert.deepEqual(kept.calls.plugins, [AIVI_PLUGIN]);
  assert.match(kept.calls.logs.join('\n'), new RegExp(`  ${ATTRIBUTION_PLUGIN} {2}kept: it is not aivi's`));

  const also = fakeIo({
    exists: path => path === configOf(home),
    opencodeOnPath: () => true,
    pluginList: () => listed,
    detectMethod: () => 'npm',
  });
  await uninstall({ home, confirm: true, withAttribution: true }, also.io);
  assert.deepEqual(also.calls.plugins, [AIVI_PLUGIN, ATTRIBUTION_PLUGIN]);
});

test('a plugin OpenCode will not give up says so and the deletion goes on', async () => {
  const home = homeOf();
  const { io, calls } = fakeIo({
    exists: path => path === configOf(home),
    opencodeOnPath: () => true,
    pluginList: () => AIVI_PLUGIN,
    pluginRemove: () => {
      throw new Error('exit 1');
    },
    detectMethod: () => 'npm',
  });
  assert.equal(await uninstall({ home, confirm: true, withAttribution: false }, io), true);
  assert.deepEqual(calls.removed, [home]);
  assert.match(calls.warns.join('\n'), /Could not remove the @aivi\/opencode plugin.*by hand/s);
});

test('OpenCode not being on PATH says which command is left to run', async () => {
  const home = homeOf();
  const { io, calls } = fakeIo({ exists: path => path === configOf(home), detectMethod: () => 'npm' });
  assert.equal(await uninstall({ home, confirm: true, withAttribution: false }, io), true);
  assert.match(calls.warns.join('\n'), /not on PATH.*opencode plugin remove @aivi\/opencode/s);
});

test('when no install method answers, the files go and the leftover is named', async () => {
  const home = homeOf();
  saveClientConfig({ home, installMethod: 'brew' });
  const { io, calls } = fakeIo({ exists: path => path === configOf(home) });
  assert.equal(
    await uninstall({ home, confirm: true, withAttribution: false }, io),
    false,
    'the CLI is still there, so the job is not done',
  );
  assert.deepEqual(calls.removed, [home]);
  assert.match(calls.warns.join('\n'), /the client config recorded brew/);
});

test('a machine aivi never touched is not an error', async () => {
  const { io, calls } = fakeIo();
  assert.equal(await uninstall({ home: undefined, confirm: false, withAttribution: false }, io), true);
  assert.match(calls.logs.join('\n'), /aivi is not installed here/);
  assert.deepEqual(calls.removed, []);
});

test('the deletion is real: the home and the client config leave the disk', async () => {
  const home = homeOf();
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(configOf(home), '{"version":1}');
  saveClientConfig({ home });
  assert.equal(existsSync(clientConfigPath()), true, 'the harness signs this machine in first');
  const { io } = fakeIo({
    exists: path => existsSync(path),
    remove: path => rmSync(path, { recursive: true, force: true }),
    detectMethod: () => 'npm',
  });
  assert.equal(await uninstall({ home, confirm: true, withAttribution: false }, io), true);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(clientConfigPath()), false);
});
