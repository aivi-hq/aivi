import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, PROJECT_ID } from './config.ts';

const run = promisify(execFile);

/** The id a repository URL implies: its last path segment without `.git`, lower-cased. */
export function projectIdFromUrl(url: string): string {
  const last = basename(url.replace(/[/\\]+$/, '').replace(/:([^/]+)$/, '/$1')).replace(/\.git$/, '');
  return last.toLowerCase();
}

/**
 * Add a project: clone into `<home>/projects/<id>`. That is the whole
 * registration; the id is checked before anything happens, and the result is
 * loaded so the caller can say what got indexed.
 */
export async function addProject(
  configPath: string,
  url: string,
  options: { id?: string; clone?: (url: string, directory: string) => Promise<void> } = {},
): Promise<{ id: string; directory: string; sources: string[] }> {
  const id = options.id ?? projectIdFromUrl(url);
  if (!PROJECT_ID.test(id)) throw new Error(`Project id "${id}" must match ${PROJECT_ID}; pass --id`);
  const directory = resolve(dirname(resolve(configPath)), 'projects', id);
  if (await stat(directory).catch(() => null)) throw new Error(`${directory} already exists`);
  const clone =
    options.clone ??
    (async (from: string, to: string) => {
      await run('git', ['clone', '--', from, to], { maxBuffer: 16 * 1024 * 1024 });
    });
  await clone(url, directory);
  const loaded = await loadConfig(configPath);
  return { id, directory, sources: loaded.sources.filter(s => s.projectId === id).map(s => s.id) };
}

/**
 * Remove a project: delete the checkout only. Its memory stays, so the project
 * is listed as removed and what was learned about it can still be asked.
 */
export async function removeProject(configPath: string, id: string): Promise<{ id: string; removed: string }> {
  const home = dirname(resolve(configPath));
  const directory = resolve(home, 'projects', id);
  if (!(await stat(directory).catch(() => null))) throw new Error(`No checkout at ${directory}`);
  await rm(directory, { recursive: true, force: true });
  return { id, removed: directory };
}

/**
 * Purge a project: delete its memory and, if still there, its checkout. What
 * would go is returned first; nothing is deleted unless `confirm` is set.
 */
export async function purgeProject(
  configPath: string,
  id: string,
  options: { confirm?: boolean } = {},
): Promise<{ id: string; paths: string[]; purged: boolean }> {
  const home = dirname(resolve(configPath));
  const paths: string[] = [];
  for (const path of [resolve(home, 'memory', id), resolve(home, 'projects', id)])
    if (await stat(path).catch(() => null)) paths.push(path);
  if (!paths.length) throw new Error(`Nothing to purge for project ${id}`);
  if (!options.confirm) return { id, paths, purged: false };
  for (const path of paths) await rm(path, { recursive: true, force: true });
  return { id, paths, purged: true };
}
