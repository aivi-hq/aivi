import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { z } from 'zod';
import type { PluginRegistry } from '../src/cli/registry.ts';

/** What the two packages' `./setupProject` export: the unit imports them
 *  itself, by package name, so they are module mocks. */
const forge = { role: 'forge', setup: async () => ({ id: 'forge' }) };
const tracker = { role: 'tracker', setup: async () => ({ id: 'tracker' }) };
mock.module('@aivi/forge-github/setupProject', { exports: { contributor: forge } });
mock.module('@aivi/tracker-linear/setupProject', { exports: { contributor: tracker } });

const {
  buildModules,
  contributorEntry,
  importContributor,
  loadComposedConfig,
  pluginDeclaration,
  pluginRegistry,
  projectContributors,
} = await import('../src/cli/registry.ts');

/** A home with a manifest listing the given entries; the workspace resolves
 *  the listed packages' `./config` from the repo root, so real first-party
 *  declarations are what these tests read. */
async function home(...entries: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(
    join(root, 'app', 'package.json'),
    JSON.stringify({ name: 'aivi-server', private: true, dependencies: {}, 'aivi-plugins': entries }),
  );
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1 }));
  return root;
}

const slackBlock = { access: { channels: [] } };

/** The block as the plugin reads it: core cannot type what it does not know. */
const asSlack = (block: unknown) => block as { commandPrefix: string };

test('a home without a manifest is a home without plugins: empty registry, core schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  const registry = await pluginRegistry(root);
  assert.deepEqual(registry.entries, []);
  assert.equal(registry.configSchema.safeParse({ version: 1 }).success, true);
  assert.equal(
    registry.configSchema.safeParse({ version: 1, plugins: { 'channel-slack': slackBlock } }).success,
    false,
    'no plugin is registered, so no block is known',
  );
});

test('the list imports each package’s declaration and composes its schema', async () => {
  const root = await home('@aivi/channel-slack');
  const registry = await pluginRegistry(root);
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0]!.name, '@aivi/channel-slack');
  assert.equal(registry.entries[0]!.enabled, true);
  assert.equal(registry.entries[0]!.plugin.id, 'channel-slack', 'the module id is the package’s own declaration');
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.deepEqual(
    loaded.config.plugins['channel-slack'],
    undefined,
    'an absent block stays absent: defaults are serve’s step',
  );
});

test('a registry read after the list changed sees the change: add’s own sequence', async () => {
  // The sequence `aivi add` runs in one process: the plugin's setup loads the
  // config, the wizard writes the block, the entry joins the list, and the
  // editor-schema rebuild must see both. A memoized registry composed the old
  // schema here and refused the config the wizard had just written.
  const root = await home();
  await loadComposedConfig(root, join(root, 'config.json'));
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { 'channel-slack': slackBlock } }));
  await writeFile(
    join(root, 'app', 'package.json'),
    JSON.stringify({
      name: 'aivi-server',
      private: true,
      dependencies: { '@aivi/channel-slack': '*' },
      'aivi-plugins': ['@aivi/channel-slack'],
    }),
  );
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.equal(
    asSlack(loaded.config.plugins['channel-slack']).commandPrefix,
    'aivi',
    'the fresh entry validates its block',
  );
});

test('the composed schema fills the plugin’s defaults and refuses an unlisted block', async () => {
  const root = await home('@aivi/channel-slack');
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { 'channel-slack': slackBlock } }));
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.equal(
    asSlack(loaded.config.plugins['channel-slack']).commandPrefix,
    'aivi',
    'the plugin schema fills its defaults',
  );
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { 'channel-discord': {} } }));
  await assert.rejects(
    loadComposedConfig(root, join(root, 'config.json')),
    /discord/,
    'a block for an unlisted plugin fails and names the key',
  );
});

test('a disabled entry keeps its schema and skips serve: the list entry is existence, enabled is running', async () => {
  const root = await home(['@aivi/channel-slack', false]);
  const registry = await pluginRegistry(root);
  assert.equal(registry.entries[0]!.enabled, false);
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { 'channel-slack': slackBlock } }));
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.equal(
    asSlack(loaded.config.plugins['channel-slack']).commandPrefix,
    'aivi',
    'a plugin on standby still validates',
  );
  const modules = await buildModules(registry, loaded, root);
  assert.deepEqual(modules, [], 'standby means serve does not build it');
});

/** A registry of one enabled plugin, as far as `buildModules` reads it: its
 *  schema and its module factory. */
function needy(t: TestContext, schema: z.ZodType, plugins: Record<string, unknown> = {}) {
  const built = { id: 'needy' };
  const createModule = t.mock.fn(async (_config: unknown, _home: string) => built);
  return {
    built,
    createModule,
    registry: {
      entries: [{ name: '@acme/needy', enabled: true, plugin: { id: 'needy', configSchema: schema, createModule } }],
    } as unknown as PluginRegistry,
    loaded: { config: { plugins } } as unknown as LoadedConfig,
  };
}

const wantsAccess = z.object({ access: z.object({ channels: z.array(z.string()) }) });

test('buildModules: an enabled entry with no block, whose own defaults do not answer, says what the schema wants', async t => {
  const plugin = needy(t, wantsAccess);

  await assert.rejects(
    buildModules(plugin.registry, plugin.loaded, '/aivi-home'),
    /@acme\/needy is in the plugin list but config\.json has no plugins\.needy block, and the plugin's own defaults do not answer: access: /,
  );
  assert.equal(plugin.createModule.mock.callCount(), 0);
});

test('buildModules: an enabled entry with a block is built from that block, as written', async t => {
  const block = { access: { channels: ['general'] } };
  const plugin = needy(t, wantsAccess, { needy: block });

  assert.deepEqual(await buildModules(plugin.registry, plugin.loaded, '/aivi-home'), [plugin.built]);
  assert.deepEqual(
    plugin.createModule.mock.calls.map(call => call.arguments),
    [[block, '/aivi-home']],
  );
});

test('buildModules: an enabled entry with no block is built from its own defaults when they answer', async t => {
  const plugin = needy(t, z.object({ mode: z.string().default('quiet') }));

  assert.deepEqual(await buildModules(plugin.registry, plugin.loaded, '/aivi-home'), [plugin.built]);
  assert.deepEqual(
    plugin.createModule.mock.calls.map(call => call.arguments),
    [[{ mode: 'quiet' }, '/aivi-home']],
  );
});

test('a listed package npm does not hold is named with the command that fixes it', async () => {
  const root = await home('@acme/not-installed');
  await assert.rejects(pluginRegistry(root), /@acme\/not-installed/);
});

test('a malformed list is said as the list, with its file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ 'aivi-plugins': [{ bad: true }] }));
  await assert.rejects(pluginRegistry(root), /aivi-plugins list in .*app\/package\.json is malformed/);
});

test('a manifest that is not JSON is said as the manifest, with its file and the parse error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'package.json'), '{ "aivi-plugins": [');
  await assert.rejects(pluginRegistry(root), /app\/package\.json is not valid JSON: /);
});

test('a listed name that is no package name at all is the engine’s own error, not the install hint', async () => {
  const root = await home('%');
  await assert.rejects(pluginRegistry(root), { code: 'ERR_INVALID_MODULE_SPECIFIER' });
});

test('a manifest with no plugin list is a home with no plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ name: 'aivi-server', private: true }));
  assert.deepEqual((await pluginRegistry(root)).entries, []);
});

test('a plugin list that is no list is said as the entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ 'aivi-plugins': '@aivi/channel-slack' }));
  await assert.rejects(
    pluginRegistry(root),
    /is malformed: entry: .*Each entry is a package name or \[name, true\|false\]\.$/,
  );
});

test('a ./config export with an id, a schema and a module factory is the plugin declaration', () => {
  const plugin = { id: 'notes', configSchema: z.object({}), createModule: async () => ({}) };
  assert.equal(pluginDeclaration('@acme/notes', plugin), plugin);
});

for (const [what, declared] of [
  ['nothing', undefined],
  ['no id', { configSchema: z.object({}), createModule: async () => ({}) }],
  ['an id that is not text', { id: 5, configSchema: z.object({}), createModule: async () => ({}) }],
  ['no config schema', { id: 'odd', createModule: async () => ({}) }],
  ['no module factory', { id: 'odd', configSchema: z.object({}) }],
] as const) {
  test(`a ./config export with ${what} is refused by its package`, () => {
    assert.throws(
      () => pluginDeclaration('@acme/odd', declared),
      new Error('@acme/odd/config exports no plugin declaration (id, configSchema, createModule are required).'),
    );
  });
}

test('the contributors are the enabled packages that export ./setupProject, with their module id and role', async () => {
  const root = await home(
    '@aivi/forge-github',
    ['@aivi/tracker-github', false],
    '@aivi/channel-slack',
    '@aivi/tracker-linear',
  );

  assert.deepEqual(
    await projectContributors(root),
    [
      { name: '@aivi/forge-github', moduleId: 'forge-github', role: 'forge', contributor: forge },
      { name: '@aivi/tracker-linear', moduleId: 'tracker-linear', role: 'tracker', contributor: tracker },
    ],
    'a disabled entry and a package with no ./setupProject take no part',
  );
});

test('a package’s ./setupProject is its contributor; a package without one, or not installed, has none', async () => {
  assert.equal(await importContributor('@aivi/tracker-linear'), tracker);
  assert.equal(await importContributor('@aivi/channel-slack'), undefined, 'the package exports no ./setupProject');
  assert.equal(await importContributor('@acme/not-installed'), undefined);
});

test('an import that fails for any other reason than a missing package is left to stand', async () => {
  await assert.rejects(importContributor('%'), { code: 'ERR_INVALID_MODULE_SPECIFIER' });
});

test('an exported contributor is an entry with its role when it names one', () => {
  const setup = async () => ({ id: 'notes' });
  assert.deepEqual(contributorEntry('@acme/notes', 'notes', { setup }), {
    name: '@acme/notes',
    moduleId: 'notes',
    contributor: { setup },
  });
  assert.deepEqual(contributorEntry('@acme/git', 'git', { role: 'forge', setup }), {
    name: '@acme/git',
    moduleId: 'git',
    role: 'forge',
    contributor: { role: 'forge', setup },
  });
});

test('an export that is no contributor, or names a role core does not know, is refused by its package', () => {
  const setup = async () => ({ id: 'odd' });
  const none = new Error('@acme/odd/setupProject exports no contributor (a { role?, setup } object).');
  assert.throws(() => contributorEntry('@acme/odd', 'odd', undefined), none);
  assert.throws(() => contributorEntry('@acme/odd', 'odd', { role: 'forge' }), none);
  assert.throws(
    () => contributorEntry('@acme/odd', 'odd', { role: 'wizard', setup }),
    new Error('@acme/odd/setupProject names a role core does not know (wizard); name one of forge, tracker or none.'),
  );
});
