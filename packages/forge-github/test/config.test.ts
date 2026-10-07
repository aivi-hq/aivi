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
  // Which is why the block holds nothing: the repositories come off each
  // project's own remote, and the app's identity — id and key both — is the
  // environment's, shared with every other plugin that speaks GitHub
  // (ruled 2026-10-07).
  assert.equal(plugin.projectSchema, undefined);
  assert.equal(plugin.projectDefaultsSchema, undefined);
});

test('an empty block is the whole block, and it reaches the config the registry parses', () => {
  const parsed = composed.parse({ version: 1, plugins: { 'forge-github': {} } });
  assert.deepEqual(parsed.plugins['forge-github'], {});
  // The empty block is not decoration: core offers the forge role to a
  // project only when the block stands, so `aivi add` writes this byte.
});

test('a block that holds anything is refused: there is no knob the block owns any more', () => {
  for (const written of [
    { app: 12345 },
    { app: '12345' },
    { installation: 99 },
    { token: 'ghs_x' },
    { privateKey: 'pem' },
  ])
    assert.equal(forgeGithubSchema.safeParse(written).success, false, `${JSON.stringify(written)} is not the block`);
});

test('listed with no block starts blind and says so at the connection, not at the parser', () => {
  // Nothing to parse, so no parse-time complaint: the module boots, reaches
  // for GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, and the ConfigurationError
  // from the credential reader is the complaint — it names what to put in
  // <home>/.env, which is the only place a credential lives.
  assert.equal(forgeGithubSchema.safeParse({}).success, true);
});

test('the module the declaration hands the host is the one id it is listed under', async () => {
  // `createModule` reaches the module code lazily: the CLI imports `./config`
  // for every command, and octokit has no business being in that import graph.
  const created = await plugin.createModule?.({}, '/tmp/aivi-home');
  assert.equal(created?.id, 'forge-github');
  assert.equal(typeof created?.start, 'function');
});
