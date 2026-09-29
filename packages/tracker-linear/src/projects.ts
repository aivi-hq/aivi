/** Linear's project sections: the write path the `aivi projects` wizard uses,
 *  the routing merge the module consults, and the cross-project checks the
 *  plugin owns because core reads nothing inside a contributed section. The
 *  file is Linear's spelling of "a project points at teams and lanes"; core
 *  discovered the checkout and knows nothing more. */
import { readFile, writeFile } from 'node:fs/promises';
import { type LoadedConfig, loadConfig, PROJECT_ID, type Project } from '@aivi/core';
import {
  type LaneBinding,
  type LinearProjectDefaults,
  type LinearProjectEntry,
  laneBinding,
  linearProjectSchema,
  type ProjectLinear,
} from './config.ts';

export type { LaneBinding } from './config.ts';

/** The `linear` section of a project entry as written — typed, or undefined.
 *  Core passes the section through; reading it is this plugin's business. */
const writtenLinear = (loaded: LoadedConfig, projectId: string): LinearProjectEntry | undefined =>
  (loaded.config.projects[projectId] as { linear?: unknown } | undefined)?.linear as LinearProjectEntry | undefined;

/** The `linear` section of `projectDefaults` as written. */
const writtenDefaults = (loaded: LoadedConfig): LinearProjectDefaults | undefined =>
  (loaded.config.projectDefaults as { linear?: unknown }).linear as LinearProjectDefaults | undefined;

/** The lanes the listener consults for one project: the projectDefaults base
 *  merged with the entry's own — entry winning one lane at a time — with the
 *  human lanes (`null`) dropped; those live in the file. */
export function projectLinear(loaded: LoadedConfig, projectId: string): ProjectLinear | undefined {
  const entry = writtenLinear(loaded, projectId);
  if (!entry) return undefined;
  const defaults = writtenDefaults(loaded);
  const merged = { ...(defaults?.lanes ?? {}), ...(entry.lanes ?? {}) };
  const lanes: Record<string, LaneBinding> = {};
  for (const [lane, value] of Object.entries(merged)) {
    const binding = laneBinding(value);
    if (binding) lanes[lane] = binding;
  }
  const workspaceId = entry.workspaceId ?? defaults?.workspaceId;
  return { teams: entry.teams, lanes, ...(workspaceId ? { workspaceId } : {}) };
}

/** A checkout receives one issue stream, so a Linear team may belong to
 *  exactly one project. Said for every collision, not just the first. */
export function linearTeamCollisions(loaded: LoadedConfig): string[] {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const [project, entry] of Object.entries(loaded.config.projects))
    for (const team of writtenLinear(loaded, project)?.teams ?? []) {
      const owner = owners.get(team);
      if (owner && owner !== project)
        collisions.push(`projects.${project}.linear.teams: this Linear team is already mapped to project ${owner}`);
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
 * Point a project at Linear teams, and optionally its lanes: writes
 * `projects.<id>.linear.teams` (and `lanes` when given) and touches nothing
 * else — every other part of the file stays as it was, an existing `lanes`
 * included when none is passed. The written file must hold: the core config
 * must still load, the section must parse against this plugin's own schema,
 * and no team may belong to two projects — if any check fails, the previous
 * bytes are restored and the error stands. The result is what got written,
 * human lanes (`null`) included.
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
    const loaded = await loadConfig(configPath);
    linearProjectSchema.parse(linear);
    // A checkout receives one issue stream: the teams just written may not
    // belong to another project too. Collisions between other projects are
    // not this write's doing; the module's start check says those.
    const mine = new Set(linear.teams as string[]);
    for (const [other, entry] of Object.entries(loaded.config.projects)) {
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
  const lanes = linear.lanes as Record<string, string | null> | undefined;
  return { id, teams: options.teams, ...(lanes ? { lanes } : {}) };
}

/**
 * The `--lane`/`--unlane` flags as a lane map, exactly what writeProjectLinear
 * writes. Each `--lane` is `LANE[,LANE…]:AGENT` — split at the *last* colon,
 * so a lane name may hold one; each `--unlane` is a lane to mark for humans
 * (`null`, a separate flag so no word is reserved). A lane given both ways is
 * an error.
 */
export function parseLaneFlags(lanes: string[], unlanes: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const entry of lanes) readLaneFlag(out, entry);
  for (const entry of unlanes) readUnlaneFlag(out, entry);
  return out;
}

/** One `--lane` entry written into the map; split at the last colon, so a
 *  lane name may hold one. */
function readLaneFlag(out: Record<string, string | null>, entry: string): void {
  const at = entry.lastIndexOf(':');
  const agent = at < 0 ? '' : entry.slice(at + 1).trim();
  if (!agent || at <= 0) throw new Error(`--lane "${entry}" must read LANE:AGENT, e.g. --lane "Dev:dev"`);
  for (const lane of entry.slice(0, at).split(',')) {
    const name = lane.trim();
    if (!name) throw new Error(`--lane "${entry}" has an empty lane name`);
    out[name] = agent;
  }
}

/** One `--unlane` entry: a lane marked for humans, unless `--lane` claimed it first. */
function readUnlaneFlag(out: Record<string, string | null>, entry: string): void {
  const name = entry.trim();
  if (!name) throw new Error('--unlane needs a lane name');
  if (out[name] !== undefined) throw new Error(`Lane "${name}" is given both --lane and --unlane; choose one`);
  out[name] = null;
}
