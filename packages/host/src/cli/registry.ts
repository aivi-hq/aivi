/** The plugin registry: the one place the command surface learns which plugins
 *  exist. The fact lives in `<home>/app/package.json` under `aivi-plugins` —
 *  the array of package names, a `[name, false]` tuple for a listed-but-disabled
 *  plugin. npm names are the install fact (`aivi add @someone/aivi-cool-plugin`);
 *  each package's `./config` subpath declares its module id — the `plugins.<id>`
 *  config key, the logger category, the `/status` id — so the two can never
 *  collide. Boot order per the plan: read the manifest, import each listed
 *  package's `./config`, compose the closed config schema; `config.json` is then
 *  parsed against that, and only `serve` honors *enabled*. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Config,
  composeConfigSchema,
  type LoadedConfig,
  loadConfig,
  type PluginProjectSections,
  type PluginProjectSectionsMap,
} from '@aivi/core';
import type { AiviModule, AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

/** One list entry: a package name, or `[name, enabled]` — the debug switch. */
const listEntry = z.union([z.string().min(1), z.tuple([z.string().min(1), z.boolean()])]);
const listSchema = z.array(listEntry);

export interface PluginEntry {
  /** The npm package name, as the list holds it. */
  name: string;
  /** false only for a `[name, false]` tuple: the plugin exists, `serve` skips it. */
  enabled: boolean;
  /** The package's own declaration, imported from its `./config` subpath. */
  plugin: AiviPlugin;
}

export interface PluginRegistry {
  /** Every listed entry, in list order — disabled ones included: they stay valid. */
  entries: PluginEntry[];
  /** core's shape with one known block per listed plugin; an editor reads this too. */
  configSchema: z.ZodType<Config>;
}

/** The list as written, or [] when the home has no manifest yet (a temp home,
 *  a smoke run: no manifest is no plugins, not an error). */
function readList(appManifest: string): [string, boolean][] {
  if (!existsSync(appManifest)) return [];
  let listed: unknown;
  try {
    const manifest = JSON.parse(readFileSync(appManifest, 'utf8')) as { ['aivi-plugins']?: unknown };
    listed = manifest['aivi-plugins'] ?? [];
  } catch (error) {
    throw new Error(`${appManifest} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = listSchema.safeParse(listed);
  if (!parsed.success)
    throw new Error(
      `The aivi-plugins list in ${appManifest} is malformed: ${parsed.error.issues
        .map(i => `${i.path.join('.') || 'entry'}: ${i.message}`)
        .join('; ')}. Each entry is a package name or [name, true|false].`,
    );
  return parsed.data.map(entry => (typeof entry === 'string' ? ([entry, true] as [string, boolean]) : entry));
}

/** Ask a listed package what it is. A package the list names but npm does not
 *  hold is a broken install, said by the command that fixes it. */
async function declarationOf(name: string): Promise<AiviPlugin> {
  let declared: unknown;
  try {
    declared = (await import(`${name}/config`)).plugin;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      throw new Error(
        `${name} is listed in app/package.json but its package is not installed here (or declares no ./config). Fix the list with \`aivi remove ${name}\`, or install it with \`aivi add ${name}\`.`,
      );
    throw error;
  }
  const declaration = declared as Partial<AiviPlugin> | undefined;
  if (!declaration || typeof declaration.id !== 'string' || !declaration.configSchema || !declaration.createModule)
    throw new Error(`${name}/config exports no plugin declaration (id, configSchema, createModule are required).`);
  return declaration as AiviPlugin;
}

/** The home's registry, read fresh per call: the manifest plus one light
 *  `./config` import per listed package — no platform SDK, no commander. The
 *  import itself is already cached by the ESM loader, so there is nothing to
 *  memoize — and memoizing would poison the one process that changes the
 *  list mid-run: `aivi add` runs a plugin's setup, lists it, then rebuilds
 *  the editor schema, which must see the entry the same command just wrote
 *  (measured 2026-09-28: a cached registry composed without the new block
 *  and refused the config the wizard had just written). */
export async function pluginRegistry(home: string): Promise<PluginRegistry> {
  const entries: PluginEntry[] = [];
  for (const [name, enabled] of readList(resolve(home, 'app', 'package.json')))
    entries.push({ name, enabled, plugin: await declarationOf(name) });
  const schemas: Record<string, z.ZodType> = {};
  const projectSections: PluginProjectSectionsMap = {};
  for (const entry of entries) {
    schemas[entry.plugin.id] = entry.plugin.configSchema;
    const sections: PluginProjectSections = {
      ...(entry.plugin.projectSchema ? { project: entry.plugin.projectSchema } : {}),
      ...(entry.plugin.projectDefaultsSchema ? { defaults: entry.plugin.projectDefaultsSchema } : {}),
    };
    if (sections.project || sections.defaults) projectSections[entry.plugin.id] = sections;
  }
  return { entries, configSchema: composeConfigSchema(schemas, projectSections) };
}

/** The home's config, validated against the composed schema: a block for an
 *  unlisted plugin fails here, and so does an unparseable core config. */
export async function loadComposedConfig(home: string, configPath: string): Promise<LoadedConfig> {
  const registry = await pluginRegistry(home);
  return loadConfig(configPath, registry.configSchema);
}

/** The modules `aivi serve` runs: one per entry the list enables. The config
 *  block is configuration, never enablement; an enabled entry with no block
 *  takes its own defaults — or the plugin's own complaint about being enabled
 *  unconfigured, since its schema demands what no default answers. */
export async function buildModules(
  registry: PluginRegistry,
  loaded: LoadedConfig,
  home: string,
): Promise<AiviModule[]> {
  const modules: AiviModule[] = [];
  for (const entry of registry.entries) {
    if (!entry.enabled) continue;
    const id = entry.plugin.id;
    const block = loaded.config.plugins[id];
    if (block === undefined) {
      const defaulted = entry.plugin.configSchema.safeParse({});
      if (!defaulted.success)
        throw new Error(
          `${entry.name} is in the plugin list but config.json has no plugins.${id} block, and the plugin's own defaults do not answer: ${defaulted.error.issues
            .map(issue => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      modules.push(await entry.plugin.createModule(defaulted.data, home));
    } else modules.push(await entry.plugin.createModule(block, home));
  }
  return modules;
}
