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
import { errorMessage, type ProjectLaneInput, type ProjectRole, print, projectRoles } from '@aivi/core';
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

/** The project entry as written: the core `lanes` array (when a contributor
 *  offered one) and each contributor's section merged under its module id;
 *  the file must load against the composed schema or the old bytes return
 *  (core's lane validation and the plugin's own `projectSchema` are what
 *  reject a bad write). */
async function writeProjectSections(
  configPath: string,
  id: string,
  sections: Record<string, Record<string, unknown>>,
  lanes?: ProjectLaneInput[],
): Promise<void> {
  const { registry } = await context();
  const before = await readFile(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  const projects = (raw.projects ?? {}) as Record<string, unknown>;
  raw.projects = projects;
  projects[id] = {
    ...(projects[id] as Record<string, unknown> | undefined),
    ...(lanes ? { lanes } : {}),
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

  let projectId: string | undefined = options.name;
  const sections: Record<string, Record<string, unknown>> = {};
  let lanes: ProjectLaneInput[] | undefined;
  let cloned = false;

  /** Run one contributor, folding its answer in: the first to name the
   *  project settles it, later ones keep it; its section is written whole. */
  const run = async (chosen: ProjectContributorEntry): Promise<void> => {
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
      // The checkout is created here before anything asks, so it always
      // exists when OpenCode is pointed at it. `ensure`: when no service
      // answers, start one — a wizard that cannot list agents is a broken
      // wizard, so a failure here is said, not swallowed.
      async agents(projectId: string): Promise<string[]> {
        const source = join(options.home, 'projects', projectId, 'source');
        await mkdir(source, { recursive: true });
        const client = await connectOpenCode({ ...loaded.config.opencode, lifecycle: 'ensure' });
        const listed = await client.agent.list({ location: { directory: source } });
        // A lane runs its agent as the session's primary; OpenCode says
        // which agents can be (`mode`), so the subagent-only ones never
        // show up as a lane's worker.
        return listed.data.filter(agent => agent.mode !== 'subagent').map(agent => agent.id);
      },
      async withStore(fn) {
        return withStore((await context()).loaded, fn);
      },
    };
    const defaults = (loaded.config.projectDefaults as Record<string, unknown>)[chosen.moduleId];
    if (defaults !== undefined) ctx.projectDefaults = defaults as Record<string, unknown>;
    if (projectId !== undefined) ctx.projectId = projectId;
    const result = await chosen.contributor.setup(ctx);
    projectId ??= result.id;
    if (result.section) sections[chosen.moduleId] = result.section;
    // One workflow per project: the tracker role offers the lane array it
    // read from its board; a second contributor offering one is a conflict,
    // never a merge.
    if (result.lanes) {
      if (lanes) throw new Error(`${chosen.moduleId} also named a lane array; a project has one workflow`);
      lanes = result.lanes;
    }
    cloned ||= result.cloned === true;
  };

  try {
    for (const { role, candidates } of plan.roles) {
      if (!candidates.length) continue;
      const chosen = await pickForRole(role, candidates);
      await run(chosen);
    }
    for (const extra of plan.extras) await run(extra);

    if (!projectId) {
      const answer = await p.text({ message: 'Project name', placeholder: 'e.g. research' });
      if (p.isCancel(answer)) throw new PluginSetupCancelled('no project name');
      projectId = String(answer).trim() || undefined;
    }
    if (!projectId) throw new Error('no project name and no configured plugin to offer one');

    // The checkout must exist before the config names the project: a project
    // directory with neither source/ nor memory/ is a mistake, not a project.
    if (!cloned) {
      const source = join(options.home, 'projects', projectId, 'source');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'AGENTS.md'), UNTRACKED_NOTE, { flag: 'wx' }).catch(() => {});
    }
    await writeProjectSections(options.configPath, projectId, sections, lanes);
    p.outro(
      cloned
        ? `${projectId} is set up.${sectionsTrailing(sections)} Restart \`aivi serve\` to index it.`
        : `${projectId} has no source host (no forge configured); its directory is untracked and holds a note. ${sectionsTrailing(sections)}Restart \`aivi serve\` to index it.`,
    );
    return projectId;
  } catch (error) {
    if (error instanceof PluginSetupCancelled) p.cancel('Setup stopped. Nothing was written.');
    else p.cancel(`Setup stopped: ${errorMessage(error)}. Nothing further was written.`);
    process.exitCode = 1;
    return undefined;
  }
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
