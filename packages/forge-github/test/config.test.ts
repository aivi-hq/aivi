/** The registry declaration, tested against the schema it is composed into:
 *  this is where a plugin's block stops being its own file and becomes part of
 *  `config.json`, so the closure (what a block may hold, and what it must
 *  hold) is the thing to prove.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeConfigSchema } from '@aivi/core';
import { forgeGithubSchema, plugin } from '../src/config.ts';

const composed = composeConfigSchema({ 'forge-github': forgeGithubSchema });

test('the declaration names the module the config block and the logs are keyed by', () => {
  assert.equal(plugin.id, 'forge-github');
  assert.equal(typeof plugin.createModule, 'function');
  // Which is why it holds nothing else: the repositories come off each project's
  // own remote, the key comes from the environment.
  assert.equal(plugin.projectSchema, undefined);
  assert.equal(plugin.projectDefaultsSchema, undefined);
});

test('a configured block is one number, and it reaches the config the registry parses', () => {
  const parsed = composed.parse({ version: 1, plugins: { 'forge-github': { app: 12345 } } });
  assert.deepEqual(parsed.plugins['forge-github'], { app: 12345 });
});

test('a block that holds more than the app id is refused: there is no knob for a second installation', () => {
  for (const written of [
    { app: '12345' },
    { app: 0 },
    { app: -1 },
    { app: 1.5 },
    { app: 12345, installation: 99 },
    { app: 12345, installationId: 99 },
    { app: 12345, token: 'ghs_x' },
    {},
  ])
    assert.equal(forgeGithubSchema.safeParse(written).success, false, `${JSON.stringify(written)} is not the block`);
});

test('listed with no block is a failure that says what is missing, not a module that starts blind', () => {
  const missing = forgeGithubSchema.safeParse({});
  assert.equal(missing.success, false);
  assert.match(missing.error?.issues[0]?.path.join('.') ?? '', /^app$/);
});

test('the module the declaration hands the host is the one id it is listed under', async () => {
  // `createModule` reaches the module code lazily: the CLI imports `./config`
  // for every command, and octokit has no business being in that import graph.
  const created = await plugin.createModule?.({ app: 7 }, '/tmp/aivi-home');
  assert.equal(created?.id, 'forge-github');
  assert.equal(typeof created?.start, 'function');
});
