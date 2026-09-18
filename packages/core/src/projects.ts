import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, PROJECT_ID, projectLayout } from './config.ts';

const run = promisify(execFile);

/** The id a repository URL implies: its last path segment without `.git`, lower-cased. */
export function projectIdFromUrl(url: string): string {
  const last = basename(url.replace(/[/\\]+$/, '').replace(/:([^/]+)$/, '/$1')).replace(/\.git$/, '');
  return last.toLowerCase();
}

/**
 * Add a project: clone into `<home>/projects/<id>/source`. That is the whole
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
  const layout = projectLayout(resolve(dirname(resolve(configPath)), 'projects', id));
  if (await stat(layout.source).catch(() => null)) throw new Error(`${layout.source} already exists`);
  const directory = layout.source;
  await mkdir(layout.root, { recursive: true });
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
 * Point a project at Linear teams: writes `projects.<id>.linear.teams` and
 * touches nothing else — an existing `lanes` and every other part of the file
 * stay as they were. The written file must load: if it does not, the previous
 * bytes are restored and the error stands. The result is what got written.
 */
export async function writeProjectLinear(
  configPath: string,
  id: string,
  teams: string[],
): Promise<{ id: string; teams: string[]; lanes?: Record<string, string> }> {
  if (!PROJECT_ID.test(id)) throw new Error(`Project id "${id}" must match ${PROJECT_ID}`);
  if (!teams.length) throw new Error('Set at least one Linear team');
  const before = await readFile(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;
  raw.projects = projects;
  const entry = (projects[id] ?? {}) as Record<string, unknown>;
  projects[id] = entry;
  const linear = (entry.linear ?? {}) as Record<string, unknown>;
  entry.linear = linear;
  linear.teams = teams;
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    await loadConfig(configPath);
  } catch (error) {
    await writeFile(configPath, before);
    throw error;
  }
  const lanes = linear.lanes as Record<string, string> | undefined;
  return { id, teams, ...(lanes ? { lanes } : {}) };
}

/**
 * Remove a project: delete the checkout and any worktrees. Its memory stays, so
 * the project is listed as removed and what was learned about it can still be
 * asked.
 */
export async function removeProject(configPath: string, id: string): Promise<{ id: string; removed: string }> {
  const layout = projectLayout(resolve(dirname(resolve(configPath)), 'projects', id));
  if (!(await stat(layout.source).catch(() => null))) throw new Error(`No checkout at ${layout.source}`);
  await rm(layout.worktrees, { recursive: true, force: true });
  await rm(layout.source, { recursive: true, force: true });
  await mkdir(layout.memory, { recursive: true });
  return { id, removed: layout.source };
}

/**
 * Purge a project: delete its whole directory, memory included. What would go
 * is returned first; nothing is deleted unless `confirm` is set.
 */
export async function purgeProject(
  configPath: string,
  id: string,
  options: { confirm?: boolean } = {},
): Promise<{ id: string; paths: string[]; purged: boolean }> {
  const home = dirname(resolve(configPath));
  const paths: string[] = [];
  for (const path of [resolve(home, 'projects', id)]) if (await stat(path).catch(() => null)) paths.push(path);
  if (!paths.length) throw new Error(`Nothing to purge for project ${id}`);
  if (!options.confirm) return { id, paths, purged: false };
  for (const path of paths) await rm(path, { recursive: true, force: true });
  return { id, paths, purged: true };
}
