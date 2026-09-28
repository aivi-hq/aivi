import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildModules, loadComposedConfig, pluginRegistry } from '../src/cli/registry.ts';

/** A home with a manifest listing the given entries; the workspace resolves
 *  the listed packages' `./config` from the repo root, so real first-party
 *  declarations are what these tests read. */
async function home(...entries: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(
    join(root, 'app', 'package.json'),
    JSON.stringify({ name: 'aivi-server', private: true, dependencies: {}, ['aivi-plugins']: entries }),
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
    registry.configSchema.safeParse({ version: 1, plugins: { slack: slackBlock } }).success,
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
  assert.equal(registry.entries[0]!.plugin.id, 'slack', 'the module id is the package’s own declaration');
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.deepEqual(loaded.config.plugins.slack, undefined, 'an absent block stays absent: defaults are serve’s step');
});

test('the composed schema fills the plugin’s defaults and refuses an unlisted block', async () => {
  const root = await home('@aivi/channel-slack');
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { slack: slackBlock } }));
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.equal(asSlack(loaded.config.plugins.slack).commandPrefix, 'aivi', 'the plugin schema fills its defaults');
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { discord: {} } }));
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
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { slack: slackBlock } }));
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  assert.equal(asSlack(loaded.config.plugins.slack).commandPrefix, 'aivi', 'a plugin on standby still validates');
  const modules = await buildModules(registry, loaded, root);
  assert.deepEqual(modules, [], 'standby means serve does not build it');
});

test('buildModules: an enabled entry with no block takes its defaults or its own complaint', async () => {
  const root = await home('@aivi/channel-slack');
  const registry = await pluginRegistry(root);
  const loaded = await loadComposedConfig(root, join(root, 'config.json'));
  // Slack's schema demands `access`: an enabled plugin with nothing to read says so.
  await assert.rejects(
    buildModules(registry, loaded, root),
    /@aivi\/channel-slack is in the plugin list but config\.json has no plugins\.slack block[\s\S]*access/,
  );
  // With the block written, the module is built from the plugin's own code.
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, plugins: { slack: slackBlock } }));
  const built = await loadComposedConfig(root, join(root, 'config.json'));
  const modules = await buildModules(registry, built, root);
  assert.deepEqual(
    modules.map(m => m.id),
    ['slack'],
  );
});

test('a listed package npm does not hold is named with the command that fixes it', async () => {
  const root = await home('@acme/not-installed');
  await assert.rejects(pluginRegistry(root), /@acme\/not-installed/);
});

test('a malformed list is said as the list, with its file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-registry-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ ['aivi-plugins']: [{ bad: true }] }));
  await assert.rejects(pluginRegistry(root), /aivi-plugins list in .*app\/package\.json is malformed/);
});
