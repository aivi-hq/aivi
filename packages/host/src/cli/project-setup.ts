/** The project-setup runner behind `aivi projects add`: core's roles, walked
 *  in order, each served by the one configured plugin that declared it, then
 *  any configured plugin that serves no role. Core spells only the systems
 *  (`forge`, then `tracker`); the plugin asks its own platform questions and
 *  hands back the section to write — and the tracker role hands back the
 *  project's **core** `lanes` array, the ordered workflow it just read from
 *  its board. Nothing platform-specific lives here. A forge clones the
 *  checkout; with no forge the runner leaves an untracked directory and
 *  says so. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  errorMessage,
  type LoadedConfig,
  type ProjectLaneInput,
  type ProjectRole,
  print,
  projectRoles,
} from '@aivi/core';
import { PluginSetupCancelled, type ProjectSetupContext } from '@aivi/plugin';
import * as p from '@clack/prompts';
import { connectOpenCode } from '../opencode.ts';
import { context, withStore } from './context.ts';
import type { ProjectContributorEntry } from './registry.ts';
import { projectContributors } from './registry.ts';

/** A directory written into a project that no forge cloned: the checkout is
 *  there so aivi discovers the project, and the note is the whole story. */
const UNTRACKED_NOTE =
  '# No source\n\nThis project has no source checkout — no forge is configured to clone one.\nIts memory and knowledge still work; nothing here is a git repository.\n';

/** The order contributors take part in, decided from what is configured. Pure,
 *  so the decision is testable apart from the prompts: a role with several
 *  configured plugins is a choice (it owns the checkout or the issue stream,
 *  so only one runs); the plugins that serve no role all run, after the roles,
 *  each adding its own section. */
export interface ProjectSetupPlan {
  roles: { role: ProjectRole; candidates: ProjectContributorEntry[] }[];
  extras: ProjectContributorEntry[];
}

export function projectSetupPlan(
  all: ProjectContributorEntry[],
  isConfigured: (moduleId: string) => boolean,
): ProjectSetupPlan {
  const configured = all.filter(entry => isConfigured(entry.moduleId));
  return {
    roles: projectRoles.map(role => ({ role, candidates: configured.filter(c => c.role === role) })),
    extras: configured.filter(c => c.role === undefined),
  };
}

/** The project entry as written: core's own fields (the `lanes` array when a
 *  contributor offered one, `sync: false` when no forge cloned a repository)
 *  and each contributor's section merged under its module id; the file must
 *  load against the composed schema or the old bytes return (core's lane
 *  validation and the plugin's own `projectSchema` are what reject a bad
 *  write). */
async function writeProjectSections(
  configPath: string,
  id: string,
  sections: Record<string, Record<string, unknown>>,
  core: { lanes?: ProjectLaneInput[]; sync?: false },
): Promise<void> {
  const { registry } = await context();
  const before = await readFile(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;
  raw.projects = projects;
  projects[id] = {
    ...(projects[id] as Record<string, unknown> | undefined),
    ...(core.lanes ? { lanes: core.lanes } : {}),
    ...(core.sync === false ? { sync: false } : {}),
    ...sections,
  };
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    registry.configSchema.parse(raw);
  } catch (error) {
    await writeFile(configPath, before);
    throw error;
  }
}

/**
 * Set a project up: walk core's roles, then the roleless plugins, run each
 * configured contributor's `./setupProject`, and write the sections they
 * return under the project. The project name is asked once — the first
 * contributor to settle it offers the default (a forge's repo name, a
 * tracker's team name); the rest keep it. Returns the settled id, or
 * undefined when the flow stopped.
 */
/** Who could work a lane, listed from the project's own checkout. The
 *  checkout is created here before anything asks, so it always exists when
 *  OpenCode is pointed at it. `ensure`: when no service answers, start one —
 *  a wizard that cannot list agents is a broken wizard, so a failure here is
 *  said, not swallowed. A lane runs its agent as the session's primary;
 *  OpenCode says which agents can be (`mode`), so the subagent-only ones
 *  never show up as a lane's worker. */
async function listLaneAgents(home: string, loaded: LoadedConfig, projectId: string): Promise<string[]> {
  const source = join(home, 'projects', projectId, 'source');
  await mkdir(source, { recursive: true });
  const client = await connectOpenCode({ ...loaded.config.opencode, lifecycle: 'ensure' });
  const listed = await client.agent.list({ location: { directory: source } });
  return listed.data.filter(agent => agent.mode !== 'subagent').map(agent => agent.id);
}

export async function runProjectSetup(options: {
  home: string;
  configPath: string;
  name?: string;
}): Promise<string | undefined> {
  if (!process.stdin.isTTY)
    throw new Error(
      'projects add needs an interactive terminal; to set a project up without one, write its block in config.json by hand (docs/projects.md).',
    );
  const loaded = (await context()).loaded;
  const all = await projectContributors(options.home);
  // A contributor is *configured* when its plugin has a block to read: no
  // block, no credentials, nothing it could set up. Core computes this.
  const plan = projectSetupPlan(
    all,
    moduleId => (loaded.config.plugins as Record<string, unknown>)[moduleId] !== undefined,
  );

  const answers: SetupAnswers = { sections: {}, cloned: false };
  if (options.name !== undefined) answers.projectId = options.name;

  try {
    for (const { role, candidates } of plan.roles) {
      if (!candidates.length) continue;
      await runContributor(await pickForRole(role, candidates), options, loaded, plan, answers);
    }
    for (const extra of plan.extras) await runContributor(extra, options, loaded, plan, answers);

    if (!answers.projectId) answers.projectId = await askProjectName();
    if (!answers.projectId) throw new Error('no project name and no configured plugin to offer one');
    const projectId = answers.projectId;

    // The checkout must exist before the config names the project.
    if (!answers.cloned) await ensureUntrackedSource(options.home, projectId);
    await writeProjectSections(options.configPath, projectId, answers.sections, {
      ...(answers.lanes ? { lanes: answers.lanes } : {}),
      // Nothing was cloned, so the config says the sync has no business here;
      // the hourly job reads the fact instead of discovering it as a skip.
      ...(answers.cloned ? {} : { sync: false }),
    });
    p.outro(outroFor(projectId, answers));
    return projectId;
  } catch (error) {
    sayStopped(error);
    return undefined;
  }
}

/** The project's name, asked of the person once when no contributor named
 *  one: a cancel stops the wizard, blank is no answer. */
async function askProjectName(): Promise<string | undefined> {
  const answer = await p.text({ message: 'Project name', placeholder: 'e.g. research' });
  if (p.isCancel(answer)) throw new PluginSetupCancelled('no project name');
  return String(answer).trim() || undefined;
}

/** The wizard's last line, per the state of the checkout: a forge brought
 *  the source, or the directory is untracked and says so. */
function outroFor(projectId: string, answers: SetupAnswers): string {
  if (answers.cloned)
    return `${projectId} is set up.${sectionsTrailing(answers.sections)} Restart \`aivi serve\` to index it.`;
  return `${projectId} has no source host (no forge configured); its directory is untracked and holds a note. ${sectionsTrailing(answers.sections)}Restart \`aivi serve\` to index it.`;
}

/** The wizard's stop: the person's cancel is said short, a failure with its
 *  reason; either way nothing was written and the exit code says so. */
function sayStopped(error: unknown): void {
  if (error instanceof PluginSetupCancelled) p.cancel('Setup stopped. Nothing was written.');
  else p.cancel(`Setup stopped: ${errorMessage(error)}. Nothing further was written.`);
  process.exitCode = 1;
}

/** What the contributors have answered so far: the project the first one
 *  named, each one's section whole, the one lane array, and whether any of
 *  them brought a checkout. */
interface SetupAnswers {
  projectId?: string | undefined;
  sections: Record<string, Record<string, unknown>>;
  lanes?: ProjectLaneInput[];
  cloned: boolean;
}

/** Run one contributor with its configured context, folding its answer into
 *  the ones so far (decision above: `SetupAnswers`). */
async function runContributor(
  chosen: ProjectContributorEntry,
  options: { home: string; configPath: string },
  loaded: LoadedConfig,
  plan: ProjectSetupPlan,
  answers: SetupAnswers,
): Promise<void> {
  const ctx: ProjectSetupContext = {
    home: options.home,
    configPath: options.configPath,
    config: (loaded.config.plugins as Record<string, unknown>)[chosen.moduleId] as Record<string, unknown>,
    print: (value, output) => print(value, output),
    prompts: p,
    fetch: (url, init) => fetch(url, init),
    // Whether a checkout with git is possible here: a plugin serving
    // core's `forge` role is configured. Core's fact, never a plugin name.
    forgeConfigured: plan.roles.some(r => r.role === 'forge' && r.candidates.length > 0),
    // Who could work a lane, listed from the project's own checkout.
    agents: projectId => listLaneAgents(options.home, loaded, projectId),
    async withStore(fn) {
      return withStore((await context()).loaded, fn);
    },
  };
  const defaults = (loaded.config.projectDefaults as Record<string, unknown>)[chosen.moduleId];
  if (defaults !== undefined) ctx.projectDefaults = defaults as Record<string, unknown>;
  if (answers.projectId !== undefined) ctx.projectId = answers.projectId;
  const result = await chosen.contributor.setup(ctx);
  answers.projectId ??= result.id;
  if (result.section) answers.sections[chosen.moduleId] = result.section;
  if (result.lanes) {
    if (answers.lanes) throw new Error(`${chosen.moduleId} also named a lane array; a project has one workflow`);
    answers.lanes = result.lanes;
  }
  answers.cloned ||= result.cloned === true;
}

/** The checkout the wizard itself made: a directory with a note saying it is
 *  untracked, so a project without a forge is a known state and not a lost
 *  clone. The note is written once and never overwritten. */
async function ensureUntrackedSource(home: string, projectId: string): Promise<void> {
  const source = join(home, 'projects', projectId, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'AGENTS.md'), UNTRACKED_NOTE, { flag: 'wx' }).catch(() => {});
}

/** The one contributor for a role: none, the only one, or a pick when several
 *  plugins serve it (a role owns the checkout or the issue stream, so one). */
async function pickForRole(role: ProjectRole, candidates: ProjectContributorEntry[]): Promise<ProjectContributorEntry> {
  if (candidates.length === 1) return candidates[0]!;
  const picked = await p.select({
    message: `Which ${role} sets up this project?`,
    options: candidates.map(c => ({ value: c.moduleId, label: c.moduleId })),
  });
  if (p.isCancel(picked)) throw new PluginSetupCancelled('no plugin chosen');
  return candidates.find(c => c.moduleId === picked)!;
}

const sectionsTrailing = (sections: Record<string, unknown>): string => {
  const ids = Object.keys(sections);
  return ids.length ? `Configured for ${ids.join(', ')}. ` : '';
};
