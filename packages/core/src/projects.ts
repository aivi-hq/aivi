import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { projectLayout } from './config.ts';

// No clone lives here. A project's checkout is a **forge's** work: the plugin
// that owns repositories clones it in its own `./setupProject` (git is the
// forge's business, not core's). What core does is discover the directories of
// `<home>/projects` and remove them; that is all `projects.ts` holds.

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
  const projectDir = resolve(home, 'projects', id);
  if (await stat(projectDir).catch(() => null)) paths.push(projectDir);
  if (!paths.length) throw new Error(`Nothing to purge for project ${id}`);
  if (!options.confirm) return { id, paths, purged: false };
  for (const path of paths) await rm(path, { recursive: true, force: true });
  return { id, paths, purged: true };
}
