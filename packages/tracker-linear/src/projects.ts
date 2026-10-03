/** Linear's project sections: the write path the `aivi projects` wizard uses,
 *  the routing the module consults, and the cross-project checks the plugin
 *  owns because core reads nothing inside a contributed section. Teams are
 *  Linear's own; the **lanes are core's** — this file writes them into the
 *  project's core `lanes` array and reads nothing back from it. */
import { readFile, writeFile } from 'node:fs/promises';
import { type LoadedConfig, loadConfig, PROJECT_ID, type Project, type ProjectLaneInput } from '@aivi/core';
import type { LinearProjectDefaults, LinearProjectEntry, ProjectLinear } from './config.ts';
import { linearProjectSchema } from './config.ts';

/** The module id, which is also the key of this plugin's section under every
 *  project and under `projectDefaults`: core writes what it is keyed by, so one
 *  word names both and a person never guesses which is which. */
const SECTION = 'tracker-linear';

/** The `tracker-linear` section of a project entry as written — typed, or
 *  undefined. Core passes the section through; reading it is this plugin's
 *  business. */
const writtenLinear = (loaded: LoadedConfig, projectId: string): LinearProjectEntry | undefined =>
  (loaded.config.projects[projectId] as Record<string, unknown> | undefined)?.[SECTION] as
    | LinearProjectEntry
    | undefined;

/** The `tracker-linear` section of `projectDefaults` as written. */
const writtenDefaults = (loaded: LoadedConfig): LinearProjectDefaults | undefined =>
  (loaded.config.projectDefaults as Record<string, unknown>)[SECTION] as LinearProjectDefaults | undefined;

/** The project's Linear routing as it takes effect: which teams speak for it
 *  and in which workspace. Lanes are not here — they are core's ordered
 *  workflow on the `Project` itself (`projects.<id>.lanes`), which the
 *  orchestrator reads to decide moves and this plugin only ever performs. */
export function projectLinear(loaded: LoadedConfig, projectId: string): ProjectLinear | undefined {
  const entry = writtenLinear(loaded, projectId);
  if (!entry) return undefined;
  const workspaceId = entry.workspaceId ?? writtenDefaults(loaded)?.workspaceId;
  return { teams: entry.teams, ...(workspaceId ? { workspaceId } : {}) };
}

/** A checkout receives one issue stream, so a Linear team may belong to
 *  exactly one project. Said for every collision, not just the first. */
export function linearTeamCollisions(loaded: LoadedConfig): string[] {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const project of Object.keys(loaded.config.projects))
    for (const team of writtenLinear(loaded, project)?.teams ?? []) {
      const owner = owners.get(team);
      if (owner && owner !== project)
        collisions.push(`projects.${project}.${SECTION}.teams: this Linear team is already mapped to project ${owner}`);
      owners.set(team, project);
    }
  return collisions;
}

/** A project checkout and the Linear routing that claims issues for it. */
export interface RoutedProject {
  project: Project;
  linear: ProjectLinear;
}

/** Which aivi project an issue belongs to: by the issue's Linear team, and by
 *  workspace when one is configured. */
export function projectForIssue(
  loaded: LoadedConfig,
  issue: { teamId: string; organizationId: string },
): RoutedProject | undefined {
  for (const project of loaded.projects) {
    if (project.removed) continue;
    const linear = projectLinear(loaded, project.id);
    if (!linear) continue;
    if (linear.teams.includes(issue.teamId) && (!linear.workspaceId || linear.workspaceId === issue.organizationId))
      return { project, linear };
  }
  return undefined;
}

/**
 * Point a project at Linear teams, and optionally (re)write its lanes: teams
 * go to `projects.<id>.tracker-linear.teams`, lanes to the project's **core**
 * `lanes` array — the ordered workflow, which core validates and the
 * orchestrator decides moves from. Nothing else in the file is touched; an
 * existing `lanes` stays as it was when none is passed. The written file must
 * hold: the core config must still load (which validates the lane order and
 * every `complete`/`return` reference), the section must parse against this
 * plugin's own schema, and no team may belong to two projects — if any check
 * fails, the previous bytes are restored and the error stands.
 */
export async function writeProjectLinear(
  configPath: string,
  id: string,
  options: { teams: string[]; lanes?: ProjectLaneInput[] },
): Promise<{ id: string; teams: string[]; lanes?: ProjectLaneInput[] }> {
  if (!PROJECT_ID.test(id)) throw new Error(`Project id "${id}" must match ${PROJECT_ID}`);
  if (!options.teams.length) throw new Error('Set at least one Linear team');
  const before = await readFile(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;
  raw.projects = projects;
  const entry = (projects[id] ?? {}) as Record<string, unknown>;
  projects[id] = entry;
  const linear = (entry[SECTION] ?? {}) as Record<string, unknown>;
  entry[SECTION] = linear;
  linear.teams = options.teams;
  if (options.lanes) entry.lanes = options.lanes;
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    const loaded = await loadConfig(configPath);
    linearProjectSchema.parse(linear);
    // A checkout receives one issue stream: the teams just written may not
    // belong to another project too. Collisions between other projects are
    // not this write's doing; the module's start check says those.
    const mine = new Set(linear.teams as string[]);
    for (const other of Object.keys(loaded.config.projects)) {
      if (other === id) continue;
      const shared = (writtenLinear(loaded, other)?.teams ?? []).filter(team => mine.has(team));
      if (shared.length)
        throw new Error(
          `Linear team ${shared.join(', ')} is already mapped to project ${other}; a team belongs to one project`,
        );
    }
  } catch (error) {
    await writeFile(configPath, before);
    throw error;
  }
  const lanes = entry.lanes as ProjectLaneInput[] | undefined;
  return { id, teams: options.teams, ...(lanes ? { lanes } : {}) };
}

/**
 * The `--lane`/`--unlane` flags as the ordered lane array core stores. The
 * flags state the order they are given in — first flag, first lane. Each
 * `--lane` is `LANE[,LANE…]:AGENT` (split at the *last* colon, so a lane name
 * may hold one); each `--unlane` is a lane with no agent, worked by humans,
 * a separate flag so no word is reserved. `next`/`previous` targets and the
 * queue and pool marks are the configured exception and get hand-written
 * into the file, not flagged.
 * A lane given both ways is an error.
 */
export function parseLaneFlags(lanes: string[], unlanes: string[]): ProjectLaneInput[] {
  const byName = new Map<string, ProjectLaneInput>();
  for (const entry of lanes) readLaneFlag(byName, entry);
  for (const entry of unlanes) readUnlaneFlag(byName, entry);
  return [...byName.values()];
}

/** One `--lane` entry appended to the order; split at the last colon, so a
 *  lane name may hold one. */
function readLaneFlag(out: Map<string, ProjectLaneInput>, entry: string): void {
  const at = entry.lastIndexOf(':');
  const agent = at < 0 ? '' : entry.slice(at + 1).trim();
  if (!agent || at <= 0) throw new Error(`--lane "${entry}" must read LANE:AGENT, e.g. --lane "Dev:dev"`);
  for (const lane of entry.slice(0, at).split(',')) {
    const name = lane.trim();
    if (!name) throw new Error(`--lane "${entry}" has an empty lane name`);
    if (out.has(name)) throw new Error(`Lane "${name}" is given twice`);
    out.set(name, { name, agent, worktree: true });
  }
}

/** One `--unlane` entry: a lane with no agent, unless `--lane` claimed it first. */
function readUnlaneFlag(out: Map<string, ProjectLaneInput>, entry: string): void {
  const name = entry.trim();
  if (!name) throw new Error('--unlane needs a lane name');
  if (out.has(name)) throw new Error(`Lane "${name}" is given both --lane and --unlane; choose one`);
  out.set(name, { name, worktree: true });
}
