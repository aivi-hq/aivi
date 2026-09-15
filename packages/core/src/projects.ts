import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
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
