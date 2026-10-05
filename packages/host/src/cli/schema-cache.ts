/** The editor schema: the composed config schema — core's fields plus the block
 *  of every plugin in the home's list — rendered to JSON Schema and written to
 *  `<state>/cache/schema.json`, with config.json's `$schema` pointing at it.
 *  The CLI cannot do this itself (it carries no zod and no core); it calls
 *  this after setup, add and remove, the events that change what is valid.
 *  The cache is disposable: it is rebuilt from the list, never hand-edited. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { loadComposedConfig, pluginRegistry } from './registry.ts';

/** Rebuild the home's editor schema from its plugin list and point config.json's
 *  `$schema` at it (a path relative to config.json, so the home stays movable).
 *  Runs against the composed schema, so it also proves the home parses. */
export async function writeEditorSchema(home: string): Promise<string> {
  const configPath = resolve(home, 'config.json');
  const loaded = await loadComposedConfig(home, configPath);
  const registry = await pluginRegistry(home);
  const json = JSON.stringify(
    // io: "input" describes what users may write: defaulted fields are optional.
    z.toJSONSchema(registry.configSchema, { target: 'draft-2020-12', io: 'input' }),
    null,
    2,
  );
  const file = resolve(loaded.config.stateDirectory, 'cache', 'schema.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${json}\n`);
  // The hint lives in config.json as plain JSON: `$schema` is a declared core
  // field, and rewriting the file keeps every other byte as the operator left it.
  const hint = `./${relative(home, file)}`;
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  if (raw.$schema !== hint) {
    raw.$schema = hint;
    await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return file;
}
