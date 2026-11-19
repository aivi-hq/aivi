/** The editor schema as a unit: what it writes from the composed schema, where
 *  it puts it, and how it points config.json at it. The plugin registry is a
 *  module mock that answers a small composed schema and the state directory;
 *  zod's own rendering and the scratch home's files are real. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mock, type TestContext, test } from 'node:test';
import { z } from 'zod';
import { scratchDir } from './apicli-fixture.ts';

const world = { stateDirectory: '' };
const composed = z.object({ version: z.literal(1), $schema: z.string().optional(), name: z.string().default('aivi') });
const loadComposedConfig = mock.fn(async (_home: string, _configPath: string) => ({
  config: { stateDirectory: world.stateDirectory },
}));
const pluginRegistry = mock.fn(async (_home: string) => ({ configSchema: composed }));

mock.module('../src/cli/registry.ts', { exports: { loadComposedConfig, pluginRegistry } });

const { writeEditorSchema } = await import('../src/cli/schema-cache.ts');

/** A home with the given config.json bytes and its state directory under it. */
async function homeWith(t: TestContext, config: string, state = 'state'): Promise<string> {
  const home = await scratchDir(t, 'aivi-schema-cache-');
  world.stateDirectory = join(home, state);
  await writeFile(join(home, 'config.json'), config);
  return home;
}

test('the composed schema is written under the state directory as what a person may write', async t => {
  const home = await homeWith(t, '{"version":1}');
  const file = await writeEditorSchema(home);
  assert.equal(file, join(home, 'state', 'cache', 'schema.json'));
  assert.deepEqual(loadComposedConfig.mock.calls.at(-1)!.arguments, [home, join(home, 'config.json')]);
  const written = await readFile(file, 'utf8');
  assert.ok(written.endsWith('}\n'), 'one JSON document and a newline');
  const schema = JSON.parse(written);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(Object.keys(schema.properties), ['version', '$schema', 'name']);
  assert.deepEqual(schema.required, ['version'], 'a defaulted field is optional to write');
});

test('config.json is pointed at the schema relative to itself, every other key left where it was', async t => {
  const home = await homeWith(t, '{"version":1,"name":"Clawd"}', 'var/state');
  await writeEditorSchema(home);
  assert.equal(
    await readFile(join(home, 'config.json'), 'utf8'),
    `${JSON.stringify({ version: 1, name: 'Clawd', $schema: './var/state/cache/schema.json' }, null, 2)}\n`,
  );
});

test('a config.json that already points at the schema is not rewritten, whatever its formatting', async t => {
  const config = '{ "$schema": "./state/cache/schema.json",   "version": 1 }';
  const home = await homeWith(t, config);
  await writeEditorSchema(home);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), config);
});
