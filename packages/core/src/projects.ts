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
 * Point a project at Linear teams, and optionally its lanes: writes
 * `projects.<id>.linear.teams` (and `lanes` when given) and touches nothing
 * else — every other part of the file stays as it was, an existing `lanes`
 * included when none is passed. The written file must load: if it does not,
 * the previous bytes are restored and the error stands. The result is what
 * got written, human lanes (`null`) included.
 */
export async function writeProjectLinear(
  configPath: string,
  id: string,
  options: { teams: string[]; lanes?: Record<string, string | null> },
): Promise<{ id: string; teams: string[]; lanes?: Record<string, string | null> }> {
  if (!PROJECT_ID.test(id)) throw new Error(`Project id "${id}" must match ${PROJECT_ID}`);
  if (!options.teams.length) throw new Error('Set at least one Linear team');
  const before = await readFile(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;
  raw.projects = projects;
  const entry = (projects[id] ?? {}) as Record<string, unknown>;
  projects[id] = entry;
  const linear = (entry.linear ?? {}) as Record<string, unknown>;
  entry.linear = linear;
  linear.teams = options.teams;
  if (options.lanes) linear.lanes = options.lanes;
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    await loadConfig(configPath);
  } catch (error) {
    await writeFile(configPath, before);
    throw error;
  }
  const lanes = linear.lanes as Record<string, string | null> | undefined;
  return { id, teams: options.teams, ...(lanes ? { lanes } : {}) };
}

/**
 * The `--lane`/`--unlane` flags as a lane map, exactly what writeProjectLinear
 * writes. Each `--lane` is `LANE[,LANE…]:APP` — split at the *last* colon, so
 * a lane name may hold one; each `--unlane` is a lane to mark for humans
 * (`null`, a separate flag so no word is reserved). A lane given both ways is
 * an error.
 */
export function parseLaneFlags(lanes: string[], unlanes: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const entry of lanes) {
    const at = entry.lastIndexOf(':');
    const app = at < 0 ? '' : entry.slice(at + 1).trim();
    if (!app || at <= 0) throw new Error(`--lane "${entry}" must read LANE:APP, e.g. --lane "Dev:dev"`);
    for (const lane of entry.slice(0, at).split(',')) {
      const name = lane.trim();
      if (!name) throw new Error(`--lane "${entry}" has an empty lane name`);
      out[name] = app;
    }
  }
  for (const entry of unlanes) {
    const name = entry.trim();
    if (!name) throw new Error('--unlane needs a lane name');
    if (out[name] !== undefined) throw new Error(`Lane "${name}" is given both --lane and --unlane; choose one`);
    out[name] = null;
  }
  return out;
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
