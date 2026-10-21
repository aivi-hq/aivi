/** The GitHub tracker's project sections: the write path the `aivi projects`
 *  wizard uses and the routing the module consults. Repositories are GitHub's
 *  own; the **lanes are core's** — this file writes them into the project's
 *  core `lanes` array and reads nothing back from it. One board per project,
 *  one tracker per project (D1): the orchestrator's registration guard is the
 *  fatal one; what is checked here is that a repository feeds one board only.
 */
import { renameSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { type LoadedConfig, loadConfig, PROJECT_ID, type Project, type ProjectLaneInput } from '@aivi/core';
import type { GithubProjectDefaults, GithubProjectEntry, ProjectGithub } from './config.ts';
import { githubProjectSchema } from './config.ts';

/** The module id, which is also the key of this plugin's section under every
 *  project and under `projectDefaults`. */
const SECTION = 'tracker-github';

/** The `tracker-github` section of a project entry as written — typed, or
 *  undefined. Core passes the section through; reading it is this plugin's
 *  business. */
const writtenGithub = (loaded: LoadedConfig, projectId: string): GithubProjectEntry | undefined =>
  (loaded.config.projects[projectId] as Record<string, unknown> | undefined)?.[SECTION] as
    | GithubProjectEntry
    | undefined;

/** The `tracker-github` section of `projectDefaults` as written. */
const writtenDefaults = (loaded: LoadedConfig): GithubProjectDefaults | undefined =>
  (loaded.config.projectDefaults as Record<string, unknown>)[SECTION] as GithubProjectDefaults | undefined;

/** The project's GitHub routing as it takes effect: which board speaks for it
 *  and which repositories feed it. */
export function projectGithub(loaded: LoadedConfig, projectId: string): ProjectGithub | undefined {
  const entry = writtenGithub(loaded, projectId);
  if (!entry) return undefined;
  const createLane = entry.createLane ?? writtenDefaults(loaded)?.createLane;
  return { board: entry.board, repos: entry.repos, ...(createLane ? { createLane } : {}) };
}

/** A checkout receives one issue stream, so a repository may feed exactly one
 *  project's board. Said for every collision, not just the first. */
export function githubRepoCollisions(loaded: LoadedConfig): string[] {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const project of Object.keys(loaded.config.projects))
    for (const repo of writtenGithub(loaded, project)?.repos ?? []) {
      const owner = owners.get(repo);
      if (owner && owner !== project)
        collisions.push(
          `projects.${project}.${SECTION}.repos: ${repo} already feeds project ${owner}; a repository feeds one board`,
        );
      owners.set(repo, project);
    }
  return collisions;
}

/** A project checkout and the GitHub routing that claims issues for it. */
export interface RoutedProject {
  project: Project;
  github: ProjectGithub;
}

/** Which aivi project an issue belongs to: by its repository. The board is
 *  read off the project's own section, so a ticket on a board the project
 *  does not name is not this project's ticket — that question is the board's
 *  (`ticketLane`), not the repository's. */
export function projectForIssue(loaded: LoadedConfig, issue: { repo: string }): RoutedProject | undefined {
  for (const project of loaded.projects) {
    if (project.removed) continue;
    const github = projectGithub(loaded, project.id);
    if (github?.repos.includes(issue.repo)) return { project, github };
  }
  return undefined;
}

/**
 * Point a project at its board and repositories, and optionally (re)write its
 * lanes: the section goes to `projects.<id>.tracker-github`, lanes to the
 * project's **core** `lanes` array — the ordered workflow, which core
 * validates and the orchestrator decides moves from. Nothing else in the file
 * is touched; an existing `lanes` stays as it was when none is passed. The
 * written file must hold: the core config must still load, the section must
 * parse against this plugin's own schema, and no repository may feed two
 * projects — if any check fails, the previous bytes are restored and the
 * error stands.
 */
export async function writeProjectGithub(
  configPath: string,
  id: string,
  options: { board: number; repos: string[]; lanes?: ProjectLaneInput[] },
): Promise<{ id: string; board: number; repos: string[]; lanes?: ProjectLaneInput[] }> {
  if (!PROJECT_ID.test(id)) throw new Error(`Project id "${id}" must match ${PROJECT_ID}`);
  if (!options.repos.length) throw new Error('Set at least one repository');
  const before = await readFile(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;
  raw.projects = projects;
  const entry = (projects[id] ?? {}) as Record<string, unknown>;
  projects[id] = entry;
  const github = (entry[SECTION] ?? {}) as Record<string, unknown>;
  entry[SECTION] = github;
  github.board = options.board;
  github.repos = options.repos;
  if (options.lanes) entry.lanes = options.lanes;
  await writeWhole(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    const loaded = await loadConfig(configPath);
    githubProjectSchema.parse(github);
    // A checkout receives one issue stream: the repositories just written may
    // not feed another project's board too. Collisions between other projects
    // are not this write's doing; the module's start check says those.
    const mine = new Set(github.repos as string[]);
    for (const other of Object.keys(loaded.config.projects)) {
      if (other === id) continue;
      const shared = (writtenGithub(loaded, other)?.repos ?? []).filter(repo => mine.has(repo));
      if (shared.length)
        throw new Error(`Repository ${shared.join(', ')} already feeds project ${other}; a repository feeds one board`);
    }
  } catch (error) {
    await writeWhole(configPath, before);
    throw error;
  }
  const lanes = entry.lanes as ProjectLaneInput[] | undefined;
  return { id, board: options.board, repos: options.repos, ...(lanes ? { lanes } : {}) };
}

/** Bytes land whole or not at all: temp next door, rename over the live
 *  path. The restore-on-refusal pattern protects against a bad write; the
 *  temp-then-rename protects against a half one. */
async function writeWhole(path: string, contents: string): Promise<void> {
  const temp = `${path}.aivi-tmp`;
  rmSync(temp, { force: true });
  await writeFile(temp, contents);
  renameSync(temp, path);
}
