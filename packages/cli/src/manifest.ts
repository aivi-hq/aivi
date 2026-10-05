/** The `aivi-plugins` list in `<home>/app/package.json`: the one plugin fact
 *  the CLI keeps, edited as plain JSON because the CLI carries no zod and
 *  no core. Entries are npm **package names** — what `aivi add` installs and
 *  what npm looks up — with a `[name, false]` tuple meaning a plugin that
 *  exists but stands down. The module id, the `plugins.<id>` config key, is
 *  not here: the package's own `./config` declaration carries it, and the host
 *  validates this list when it loads. */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Manifest {
  dependencies?: Record<string, string>;
  'aivi-plugins'?: unknown;
  [key: string]: unknown;
}

function readManifest(appDir: string): Manifest {
  return JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as Manifest;
}

/** Bytes land whole or not at all: temp next door, rename over. A kill
 *  mid-write used to leave truncated JSON where the install record was,
 *  and every later read — `aivi add`, the host's registry — then complained
 *  about JSON instead of knowing what it lost. */
function writeManifest(appDir: string, manifest: Manifest): void {
  const path = join(appDir, 'package.json');
  const temp = `${path}.aivi-tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temp, path);
}

/** The list entry names, tuples included: what the home holds plugins for. */
export function pluginNames(appDir: string): string[] {
  const listed = readManifest(appDir)['aivi-plugins'];
  if (!Array.isArray(listed)) return [];
  return listed.map(entry => (Array.isArray(entry) ? entry[0] : entry)).filter(name => typeof name === 'string');
}

/** The dependency names npm holds, the server itself included. */
export function dependencyNames(appDir: string): string[] {
  return Object.keys(readManifest(appDir).dependencies ?? {});
}

/** Put one package name in the list; answers false (writes nothing) when a
 *  name is already listed, tuple or not. */
export function addPluginName(appDir: string, name: string): boolean {
  const manifest = readManifest(appDir);
  const listed = Array.isArray(manifest['aivi-plugins']) ? (manifest['aivi-plugins'] as unknown[]) : [];
  const names = listed.map(entry => (Array.isArray(entry) ? entry[0] : entry));
  if (names.includes(name)) return false;
  manifest['aivi-plugins'] = [...listed, name];
  writeManifest(appDir, manifest);
  return true;
}

/** Take one package name out of the list, entry form whatever it was; answers
 *  false when it was not there. */
export function removePluginName(appDir: string, name: string): boolean {
  const manifest = readManifest(appDir);
  const listed = Array.isArray(manifest['aivi-plugins']) ? (manifest['aivi-plugins'] as unknown[]) : [];
  const kept = listed.filter(entry => (Array.isArray(entry) ? entry[0] : entry) !== name);
  if (kept.length === listed.length) return false;
  manifest['aivi-plugins'] = kept;
  writeManifest(appDir, manifest);
  return true;
}

/** The dependency names that are not the server itself, in npm's order. */
export const serverPackage = '@aivi/host';

export function pluginDependencies(appDir: string): string[] {
  return dependencyNames(appDir).filter(name => name !== serverPackage);
}
