/** The server commands over their default I/O: what `aivi add`, `remove`, `update` and `uninstall` ask of npm, OpenCode,
 *  the installed server, the service, HTTP and the disk when no I/O is handed in. The machine is a mock whose effects are
 *  recorded in order, the installed server is a mock of its modules (`../src/mount.ts`), and the home is a scratch
 *  directory: nothing here reaches a real service, registry or home. */
import assert from 'node:assert/strict';
import childProcess, { type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, type TestContext, test } from 'node:test';

/** What a command answers: any member of the real result, and a member may be missing on purpose. */
type Spawned = { [Member in keyof SpawnSyncReturns<string>]?: SpawnSyncReturns<string>[Member] | undefined };

const realExistsSync = fs.existsSync;
const realRmSync = fs.rmSync;

/** The installed server's modules; the `importApp` mock hands them out by the path it is asked for. */
const app = {
  context: mock.fn(async () => ({ loaded: { config: { identity: { name: 'Ada' } } } })),
  pluginSetup: mock.fn(async (_spec: string, _options: object): Promise<string | null | undefined> => 'discord'),
  pluginRemove: mock.fn(async (_name: string, _options: object) => ({
    moduleId: 'discord',
    blockRemoved: true,
    sectionsRemoved: 2,
  })),
  writeEditorSchema: mock.fn(async (_home: string) => 'schema.json'),
};
const serverModules: Record<string, object> = {
  'dist/cli/context.js': { context: app.context },
  'dist/cli/plugin-setup.js': { pluginSetup: app.pluginSetup },
  'dist/cli/plugin-remove.js': { pluginRemove: app.pluginRemove },
  'dist/cli/schema-cache.js': { writeEditorSchema: app.writeEditorSchema },
};
const importApp = mock.fn(async (_appDir: string, _home: string, modulePath: string) => serverModules[modulePath]);
mock.module('../src/mount.ts', { exports: { importApp } });

const { add } = await import('../src/add.ts');
const { remove } = await import('../src/remove.ts');
const { AIVI_PLUGIN, ATTRIBUTION_PLUGIN } = await import('../src/setup.ts');
const { uninstall } = await import('../src/uninstall.ts');
const { updateServer } = await import('../src/update.ts');
const { setupClock } = await import('./setup-fixture.ts');

const HOME = '/users/test';
const UNIT = join(HOME, '.config', 'systemd', 'user', 'aivi.service');
const HEALTH = 'http://127.0.0.1:4100/health';

interface Machine {
  /** The service unit exists: aivi runs as a managed service. */
  service?: boolean;
  /** The machine deletes nothing: `rmSync` records the path instead. */
  keepFiles?: boolean;
  /** What a command answers; the default is exit 0 and no output. */
  spawn?: (command: string, args: readonly string[]) => Spawned;
  /** What an HTTP request answers; the default is 200. */
  fetch?: (url: string) => Response;
}

/** A Linux machine. The returned list is what the unit did to it, in order. */
function machine(t: TestContext, spec: Machine = {}): string[] {
  const effects: string[] = [];
  t.mock.property(process, 'platform', 'linux');
  t.mock.method(os, 'homedir', () => HOME);
  t.mock.method(fs, 'existsSync', (path: string) => (spec.service === true && path === UNIT) || realExistsSync(path));
  t.mock.method(fs, 'writeSync', (_fd: number, text: string) => {
    effects.push(`say ${text.trim()}`);
    return text.length;
  });
  if (spec.keepFiles)
    t.mock.method(fs, 'rmSync', (path: string) => {
      effects.push(`rm ${path}`);
    });
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[]) => {
    effects.push(`run ${command} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '', ...spec.spawn?.(command, args) } as SpawnSyncReturns<string>;
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    effects.push(`get ${url}`);
    return spec.fetch ? spec.fetch(url) : new Response('ok');
  });
  t.mock.method(console, 'log', (line: string) => {
    effects.push(`log ${line}`);
  });
  t.mock.method(console, 'warn', (line: string) => {
    effects.push(`warn ${line}`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return effects;
}

let directory: string;
let savedClientConfig: string | undefined;
const clientConfigFile = () => join(directory, 'client.json');

beforeEach(() => {
  directory = fs.mkdtempSync(join(os.tmpdir(), 'aivi-default-io-'));
  savedClientConfig = process.env.AIVI_CONFIG;
  process.env.AIVI_CONFIG = clientConfigFile();
  importApp.mock.resetCalls();
  for (const call of Object.values(app)) call.mock.resetCalls();
});

afterEach(() => {
  if (savedClientConfig === undefined) delete process.env.AIVI_CONFIG;
  else process.env.AIVI_CONFIG = savedClientConfig;
  process.exitCode = undefined;
  realRmSync(directory, { recursive: true, force: true });
});

/** A home whose server is installed (0.1.0): the app manifest, the server's package and config.json. */
function server(manifest: object = { name: 'aivi-server', dependencies: { '@aivi/host': '0.1.0' } }) {
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  fs.mkdirSync(join(appDir, 'node_modules', '@aivi', 'host'), { recursive: true });
  fs.writeFileSync(join(appDir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(join(appDir, 'node_modules', '@aivi', 'host', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1 }));
  return { home, appDir, nodePath: process.execPath };
}

/** What `npm install` leaves behind: the package directory and its dependency in the manifest. */
function npmInstalled(appDir: string, name: string): void {
  fs.mkdirSync(join(appDir, 'node_modules', ...name.split('/')), { recursive: true });
  const path = join(appDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(path, 'utf8')) as { dependencies: Record<string, string> };
  manifest.dependencies[name] = '*';
  fs.writeFileSync(path, JSON.stringify(manifest));
}

/** `npm view` answers JSON: the target version 0.2.0, and an engines range this Node satisfies. */
const npmViews = (args: readonly string[]): Spawned =>
  args[0] === 'view' ? { stdout: args[2] === 'version' ? '"0.2.0"\n' : '">=26 <27"\n' } : {};

test('add, handed no I/O, runs npm, the plugin’s own setup and the schema rebuild, then restarts the service and reads the module state', async t => {
  const options = server();
  const effects = machine(t, {
    service: true,
    spawn: command => {
      if (command === 'npm') npmInstalled(options.appDir, '@aivi/channel-discord');
      return {};
    },
    fetch: url =>
      url.endsWith('/status')
        ? Response.json({ modules: [{ id: 'discord', state: 'running', lastError: null }] })
        : new Response('ok'),
  });

  await add(['discord'], options);

  assert.deepEqual(effects, [
    `log Installing @aivi/channel-discord into ${options.appDir}`,
    'run npm install --save-exact --no-fund @aivi/channel-discord',
    'say server restarting…',
    'run systemctl --user restart aivi.service',
    `get ${HEALTH}`,
    'get http://127.0.0.1:4100/status',
    'log Discord is running.',
  ]);
  assert.deepEqual(
    importApp.mock.calls.map(call => call.arguments),
    ['context', 'plugin-setup', 'schema-cache'].map(name => [options.appDir, options.home, `dist/cli/${name}.js`]),
  );
  assert.deepEqual(app.pluginSetup.mock.calls[0]!.arguments, [
    '@aivi/channel-discord',
    { home: options.home, configPath: join(options.home, 'config.json'), identityName: 'Ada' },
  ]);
  assert.deepEqual(app.writeEditorSchema.mock.calls[0]!.arguments, [options.home]);
});

test('add, handed no I/O, says how npm failed: by its exit, by a signal, or by not starting', async t => {
  const options = server();
  const notStarted = new Error('spawn npm ENOENT');
  let answer: Spawned = {};
  machine(t, { spawn: () => answer });
  const refusals: [Spawned, RegExp | ((error: unknown) => boolean)][] = [
    [{ status: 1 }, /^Error: npm install @aivi\/browser failed \(exit 1\)$/],
    [{ status: null }, /^Error: npm install @aivi\/browser failed \(exit signal\)$/],
    [{ status: null, error: notStarted }, error => error === notStarted],
  ];

  for (const [refusal, expected] of refusals) {
    answer = refusal;
    await assert.rejects(add(['browser'], options), expected);
  }
  assert.equal(app.pluginSetup.mock.callCount(), 0, 'nothing ran against a package that did not install');
});

test('add, handed no I/O, probes health again when the first probe fails, and fails with the module endpoint’s status', async t => {
  const options = server();
  let probes = 0;
  machine(t, {
    service: true,
    spawn: command => {
      if (command === 'npm') npmInstalled(options.appDir, '@aivi/channel-discord');
      return {};
    },
    fetch: url => {
      if (!url.endsWith('/health')) return new Response('', { status: 503 });
      if (probes++ === 0) throw new Error('connection refused');
      return new Response('ok');
    },
  });
  const waiting = setupClock(t);

  const adding = assert.rejects(add(['discord'], options), /^Error: \/status answered 503\.$/);
  assert.equal(await waiting, 500);
  t.mock.timers.tick(500);
  await adding;

  assert.equal(probes, 2, 'the refused probe counted as unhealthy, the second answered');
});

test('add, handed no I/O, only warns when the editor schema cannot be rebuilt, and the plugin stays listed', async t => {
  const options = server();
  const effects = machine(t, {
    spawn: command => {
      if (command === 'npm') npmInstalled(options.appDir, '@aivi/channel-discord');
      return {};
    },
  });
  app.writeEditorSchema.mock.mockImplementationOnce(async () => {
    throw new Error('config.json did not load');
  });

  await add(['discord'], options);

  assert.match(
    effects.at(-1)!,
    /^log the editor schema was not rebuilt \(config\.json did not load\); the plugin is listed/,
  );
  assert.equal(process.exitCode, undefined);
});

test('update, handed no I/O, asks npm for the target and its engines, installs, rebuilds the schema and restarts the managed service', async t => {
  const options = server();
  const effects = machine(t, { service: true, spawn: (_command, args) => npmViews(args) });

  await updateServer(options);

  assert.deepEqual(effects, [
    'run npm view @aivi/host@latest version --json',
    'run npm view @aivi/host@0.2.0 engines.node --json',
    'run npm install --save-exact --no-fund @aivi/host@0.2.0',
    'log Updated @aivi/host: 0.1.0 → 0.2.0.',
    'say server restarting…',
    'run systemctl --user restart aivi.service',
    `get ${HEALTH}`,
    'log The server is back and healthy.',
  ]);
  assert.deepEqual(app.writeEditorSchema.mock.calls[0]!.arguments, [options.home]);
});

test('update, handed no I/O and finding no managed service, treats an unanswered health probe as no server running', async t => {
  const options = server();
  const effects = machine(t, {
    spawn: (_command, args) => npmViews(args),
    fetch: () => {
      throw new Error('connection refused');
    },
  });

  await updateServer(options);

  assert.deepEqual(effects, [
    'run npm view @aivi/host@latest version --json',
    'run npm view @aivi/host@0.2.0 engines.node --json',
    `get ${HEALTH}`,
    'run npm install --save-exact --no-fund @aivi/host@0.2.0',
    'log Updated @aivi/host: 0.1.0 → 0.2.0.',
    'log Done. Start the server with `aivi serve`.',
  ]);
});

test('update, handed no I/O, fails with npm’s own words when npm cannot answer or install', async t => {
  const options = server();
  let answers: (args: readonly string[]) => Spawned = () => ({
    status: 1,
    stderr: ' registry offline \n',
  });
  machine(t, {
    spawn: (_command, args) => answers(args),
    fetch: () => {
      throw new Error('connection refused');
    },
  });
  await assert.rejects(updateServer(options), /^Error: npm view @aivi\/host@latest version failed: registry offline$/);

  answers = args => (args[0] === 'install' ? { status: null, stderr: undefined } : npmViews(args));
  await assert.rejects(updateServer(options), /^Error: npm install failed:\n$/);
});

test('remove, handed no I/O, drops the config through the installed server, uninstalls with npm and restarts the service', async t => {
  const options = server({
    name: 'aivi-server',
    dependencies: { '@aivi/host': '0.1.0' },
    'aivi-plugins': ['@aivi/channel-discord'],
  });
  const effects = machine(t, { service: true });

  await remove(['discord'], options);

  assert.deepEqual(effects, [
    'log @aivi/channel-discord is out of the plugin list — its plugins.discord block is gone; its 2 sections under projects and projectDefaults are gone.',
    'run npm uninstall --no-fund @aivi/channel-discord',
    'say server restarting…',
    'run systemctl --user restart aivi.service',
    `get ${HEALTH}`,
    'log @aivi/channel-discord is removed and aivi is back and healthy.',
  ]);
  assert.deepEqual(app.pluginRemove.mock.calls[0]!.arguments, [
    '@aivi/channel-discord',
    { configPath: join(options.home, 'config.json') },
  ]);
  assert.deepEqual(app.writeEditorSchema.mock.calls[0]!.arguments, [options.home]);
});

test('remove, handed no I/O, keeps going after npm or the schema rebuild fails, and says what is left', async t => {
  const options = server({
    name: 'aivi-server',
    dependencies: { '@aivi/host': '0.1.0' },
    'aivi-plugins': ['@aivi/channel-discord'],
  });
  const notStarted = new Error('spawn npm ENOENT');
  let answer: Spawned = {};
  const effects = machine(t, { spawn: () => answer });
  app.writeEditorSchema.mock.mockImplementationOnce(async () => {
    throw new Error('config.json did not load');
  });

  for (const refusal of [{ status: 2 }, { status: null }, { status: null, error: notStarted }]) {
    answer = refusal;
    fs.writeFileSync(
      join(options.appDir, 'package.json'),
      JSON.stringify({ dependencies: { '@aivi/host': '0.1.0' }, 'aivi-plugins': ['@aivi/channel-discord'] }),
    );
    await remove(['discord'], options);
  }

  const said = effects.filter(effect => effect.startsWith('log ') && effect.includes('the package stays under'));
  assert.deepEqual(
    said.map(effect => effect.split(' — ')[0]),
    [
      'log npm uninstall @aivi/channel-discord failed (exit 2)',
      'log npm uninstall @aivi/channel-discord failed (exit signal)',
      'log spawn npm ENOENT',
    ],
  );
  assert.ok(
    effects.some(effect => effect.startsWith('log the editor schema was not rebuilt (config.json did not load)')),
    'a schema that does not rebuild is said as well',
  );
  assert.ok(
    effects.at(-1)!.endsWith('is removed. The next `aivi serve` will not run it.'),
    'and with no service the next serve is the person’s to start',
  );
});

test('remove, handed no I/O, probes health again when the first probe fails', async t => {
  const options = server({
    name: 'aivi-server',
    dependencies: { '@aivi/host': '0.1.0' },
    'aivi-plugins': ['@aivi/channel-discord'],
  });
  let probes = 0;
  const effects = machine(t, {
    service: true,
    fetch: () => {
      if (probes++ === 0) throw new Error('connection refused');
      return new Response('ok');
    },
  });
  const waiting = setupClock(t);

  const removing = remove(['discord'], options);
  assert.equal(await waiting, 500);
  t.mock.timers.tick(500);
  await removing;

  assert.equal(probes, 2, 'the refused probe counted as unhealthy, the second answered');
  assert.equal(effects.at(-1), 'log @aivi/channel-discord is removed and aivi is back and healthy.');
});

test('uninstall, handed no I/O, takes the service, the OpenCode plugins, the home, the client config and the CLI off the machine', async t => {
  const options = server();
  fs.writeFileSync(clientConfigFile(), JSON.stringify({ configVersion: 1, home: options.home }));
  const effects = machine(t, {
    service: true,
    keepFiles: true,
    spawn: (command, args) => {
      if (command === 'npm' && args[0] === 'list') return { stdout: 'aivi\n└── @aivi/cli@1.0.0\n' };
      if (command === 'opencode' && args[1] === 'list') return { stdout: `${AIVI_PLUGIN}\n${ATTRIBUTION_PLUGIN}\n` };
      return {};
    },
  });

  assert.equal(await uninstall({ home: options.home, confirm: true, withAttribution: true }), true);

  assert.deepEqual(effects, [
    'run opencode --version',
    'run opencode plugin list',
    'run npm list -g @aivi/cli --depth=0',
    'log Deleting:',
    `log   ${options.home}  the aivi home`,
    `log   ${clientConfigFile()}  the client config: this machine's sign-in`,
    `log   ${UNIT}  the background service`,
    `log   ${AIVI_PLUGIN}  aivi's OpenCode plugin`,
    `log   ${ATTRIBUTION_PLUGIN}  the attribution OpenCode plugin`,
    'log   @aivi/cli  this CLI, installed with npm',
    'run systemctl --user disable --now aivi.service',
    `rm ${UNIT}`,
    'run systemctl --user daemon-reload',
    'run opencode --version',
    `run opencode plugin remove ${AIVI_PLUGIN}`,
    `log Removed the ${AIVI_PLUGIN} plugin from OpenCode.`,
    `run opencode plugin remove ${ATTRIBUTION_PLUGIN}`,
    `log Removed the ${ATTRIBUTION_PLUGIN} plugin from OpenCode.`,
    `rm ${options.home}`,
    `log Deleted ${options.home}`,
    `rm ${clientConfigFile()}`,
    `log Deleted ${clientConfigFile()}`,
    'log Removing this CLI (installed with npm) — the last thing it says.',
    'run npm uninstall -g @aivi/cli',
  ]);
});

test('uninstall, handed no I/O, says a plugin OpenCode would not give up, and that no install method answered', async t => {
  const options = server();
  let removal: Spawned = {};
  const effects = machine(t, {
    keepFiles: true,
    spawn: (command, args) => {
      if (command === 'npm') return { status: 1 };
      if (args[1] === 'list') return { stdout: AIVI_PLUGIN };
      return args[1] === 'remove' ? removal : {};
    },
    fetch: () => {
      throw new Error('connection refused');
    },
  });

  for (const refusal of [{ status: 1 }, { status: null }]) {
    removal = refusal;
    assert.equal(await uninstall({ home: options.home, confirm: true, withAttribution: false }), false);
  }

  const warnings = effects.filter(effect => effect.startsWith('warn '));
  assert.deepEqual(
    warnings.map(effect => effect.split('). Remove')[0]),
    [
      `warn Could not remove the ${AIVI_PLUGIN} plugin (opencode plugin remove ${AIVI_PLUGIN} failed (exit 1)`,
      'warn The aivi files are gone. No install method aivi knows answers; remove the CLI the way you installed it.',
      `warn Could not remove the ${AIVI_PLUGIN} plugin (opencode plugin remove ${AIVI_PLUGIN} failed (exit signal)`,
      'warn The aivi files are gone. No install method aivi knows answers; remove the CLI the way you installed it.',
    ],
  );
  assert.ok(effects.includes(`get ${HEALTH}`), 'with no service, it asked whether a server runs in the foreground');
});

test('uninstall, handed no I/O, leaves a server that answers in the foreground to the person who started it', async t => {
  const options = server();
  const effects = machine(t, { keepFiles: true });

  await assert.rejects(
    uninstall({ home: options.home, confirm: true, withAttribution: false }),
    /^Error: aivi is running in the foreground; stop it \(Ctrl\+C\) and re-run `aivi uninstall`\.$/,
  );

  assert.ok(!effects.some(effect => effect.startsWith('rm ')), 'nothing was deleted');
});

test('uninstall, handed no I/O, fails by name when OpenCode does not answer its plugin list in time', async t => {
  const options = server();
  machine(t, {
    spawn: (_command, args) =>
      args[1] === 'list' ? { status: null, error: new Error('spawnSync opencode ETIMEDOUT') } : {},
  });

  await assert.rejects(
    uninstall({ home: options.home, confirm: false, withAttribution: false }),
    /^Error: opencode plugin list did not answer within 500 ms\.$/,
  );
});

test('uninstall, handed no I/O, reads an OpenCode that lists nothing as no plugins', async t => {
  const options = server();
  const effects = machine(t, { spawn: (_command, args) => (args[1] === 'list' ? { stdout: undefined } : {}) });

  assert.equal(await uninstall({ home: options.home, confirm: false, withAttribution: false }), false);

  assert.ok(effects.includes(`log   ${options.home}  the aivi home`));
  assert.ok(!effects.some(effect => effect.includes(AIVI_PLUGIN)), 'no plugin entry is listed');
});
