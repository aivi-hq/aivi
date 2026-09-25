/** Projects: the directories of <home>/projects, their sources, and the one
 *  interactive command. */

import type { LoadedConfig } from '@aivi/core';
import {
  addProject,
  errorMessage,
  PROJECT_ID,
  parseLaneFlags,
  projectIdFromUrl,
  projectSummaries,
  purgeProject,
  removeProject,
  writeProjectLinear,
} from '@aivi/core';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { collect, configPath, context, print } from '../context.ts';

// The one interactive command: everything `projects add --linear` takes as a
// flag is asked here, and a flag that is given skips its prompt. The core
// calls — resolve teams, clone, write the config — are the same ones.

type Linear = typeof import('@aivi/linear');
type Teams = Awaited<ReturnType<Awaited<ReturnType<Linear['clientFor']>>['listTeams']>>;

interface CreateFlags {
  id?: string | undefined;
  linear?: string | undefined;
  app?: string | undefined;
  lane?: string[] | undefined;
  unlane?: string[] | undefined;
}

/**
 * A clack screen that ends the flow: nothing was cloned or written.
 * Returns undefined so a step can `return stop(...)` and the caller reads
 * "no result" as "the speaker stopped".
 */
function stop(why: string): undefined {
  p.cancel(`Setup stopped: ${why}. Nothing was cloned or written.`);
  process.exitCode = 1;
}

/** The repository URL and project id, given or asked; undefined when the speaker stopped. */
async function askRepository(argument: string | undefined, flags: CreateFlags) {
  const urlAnswer =
    argument ?? (await p.text({ message: 'Repository URL to clone', placeholder: 'git@github.com:acme/site.git' }));
  if (p.isCancel(urlAnswer)) return stop('no repository given');
  const url = urlAnswer.trim();
  if (!url) return stop('no repository given');
  const suggested = projectIdFromUrl(url);
  const idAnswer =
    flags.id ??
    (await p.text({
      message:
        "Project id — aivi's name for this checkout: the directory <home>/projects/<id> and the projects.<id> entry in config.json. Linear never sees it.",
      placeholder: suggested,
      validate: value => {
        const v = (value ?? '').trim();
        if (!v || PROJECT_ID.test(v)) return undefined;
        return 'Lowercase letters, digits, underscores or dashes; start with a letter';
      },
    }));
  if (p.isCancel(idAnswer)) return stop('no project id given');
  return { url, id: idAnswer.trim() || suggested };
}

/** What the app can see, behind a spinner; undefined when the ask failed or saw nothing. */
async function fetchTeams(client: Awaited<ReturnType<Linear['clientFor']>>): Promise<Teams | undefined> {
  const fetchSpinner = p.spinner();
  fetchSpinner.start('Asking the app which teams it can see');
  let teams: Teams;
  try {
    teams = await client.listTeams();
  } catch (error) {
    fetchSpinner.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }
  fetchSpinner.stop(`The app can see ${teams.length} team${teams.length === 1 ? '' : 's'}`);
  if (!teams.length)
    return stop('that app sees no teams — a private team needs the app added to it, or check its credentials');
  return teams;
}

/** The team keys or ids the speaker named, resolved against what the app can see. */
async function resolveTokens(
  teams: Teams,
  flags: CreateFlags,
  linear: Linear,
  id: string,
): Promise<string[] | undefined> {
  let tokens: string[];
  if (flags.linear) {
    tokens = flags.linear
      .split(/[\s,]+/)
      .map(token => token.trim())
      .filter(Boolean);
    if (!tokens.length) return stop('--linear wants at least one team key or id');
  } else {
    const picked = await p.multiselect({
      message: `Which of these teams may work in ${id}?`,
      options: teams.map(team => ({ value: team.id, label: `${team.key} — ${team.name}`, hint: team.id })),
      required: true,
    });
    if (p.isCancel(picked)) return stop('no teams picked');
    tokens = picked;
  }
  try {
    return linear.resolveTeams(teams, tokens);
  } catch (error) {
    return stop(errorMessage(error));
  }
}

const laneAgent = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && 'agent' in value
      ? String(value.agent)
      : 'null';

/** The lane map from flags, or asked lane by lane when neither flag named one. */
async function askLanes(
  loaded: LoadedConfig,
  flags: CreateFlags,
  teams: Teams,
  teamIds: string[],
): Promise<Record<string, string | null> | undefined> {
  let lanes: Record<string, string | null>;
  try {
    lanes = parseLaneFlags(flags.lane ?? [], flags.unlane ?? []);
  } catch (error) {
    return stop(errorMessage(error));
  }
  if (Object.keys(lanes).length) return lanes;
  // The convention is the base; only the lanes it leaves open get asked,
  // and a lane whose workflow state only ends work (done, canceled) never does.
  const conventions = loaded.config.projectDefaults.linear?.lanes ?? {};
  const mapped = Object.entries(conventions).filter(([, agent]) => agent !== null);
  p.note(
    mapped.length
      ? mapped.map(([lane, agent]) => `${lane} → ${laneAgent(agent)}`).join('\n')
      : 'nothing yet — every lane of the picked teams gets asked',
    'Lane convention (projectDefaults.linear.lanes)',
  );
  const selected = teams.filter(team => teamIds.includes(team.id));
  const open = [
    ...new Set(
      selected.flatMap(team =>
        team.states.filter(state => state.type !== 'completed' && state.type !== 'canceled').map(state => state.name),
      ),
    ),
  ].filter(laneName => !(laneName in conventions));
  for (const lane of open) {
    const from = selected
      .filter(team => team.states.some(state => state.name === lane))
      .map(team => team.key)
      .join(', ');
    const choice = await p.text({
      message: `Which OpenCode agent works the "${lane}" lane (of ${from})?`,
      placeholder: 'leave empty to leave it for humans',
    });
    if (p.isCancel(choice)) return stop('lane setup incomplete');
    lanes[lane] = choice.trim() ? choice.trim() : null;
  }
  if (!open.length) p.note('the convention already covers every lane these teams work in', 'Lanes');
  return lanes;
}

/** Clone the checkout and write the Linear mapping; prints the result, stops on either failure. */
async function cloneAndWrite(url: string, id: string, teamIds: string[], lanes: Record<string, string | null>) {
  const cloneSpinner = p.spinner();
  cloneSpinner.start(`Cloning ${url} into <home>/projects/${id}/source`);
  let added: Awaited<ReturnType<typeof addProject>>;
  try {
    added = await addProject(configPath, url, { id });
  } catch (error) {
    cloneSpinner.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }
  cloneSpinner.stop(`Cloned into ${added.directory}`);
  let written: Awaited<ReturnType<typeof writeProjectLinear>>;
  try {
    written = await writeProjectLinear(configPath, id, {
      teams: teamIds,
      ...(Object.keys(lanes).length ? { lanes } : {}),
    });
  } catch (error) {
    p.cancel(
      `Cloned, but writing projects.${id}.linear failed: ${errorMessage(error)}. The old file is restored; the checkout stays.`,
    );
    process.exitCode = 1;
    return;
  }
  print({ ...added, linear: written });
  return written;
}

async function projectsCreate(argument: string | undefined, flags: CreateFlags): Promise<void> {
  const { loaded, log } = await context();
  if (!loaded.config.linear) {
    throw new Error(
      'The Linear module is not configured in config.json (no `linear` block), so there is nothing to set up',
    );
  }
  if (!process.stdin.isTTY)
    throw new Error(
      'projects create needs an interactive terminal; in a script use: aivi projects add <git-url> --linear <key-or-id> [--lane "Dev:dev"] [--unlane "Backlog"]',
    );
  const linearConfig = loaded.config.linear;
  p.intro('aivi projects create');
  const repo = await askRepository(argument, flags);
  if (!repo) return;
  const appIds = Object.keys(linearConfig.apps);
  let app = flags.app;
  if (!app && appIds.length > 1) {
    const picked = await p.select({
      message: 'Ask which Linear app for teams',
      options: appIds.map(name => ({ value: name, label: name })),
    });
    if (p.isCancel(picked)) return stop('no app chosen');
    app = picked;
  }
  const linear: Linear = await import('@aivi/linear');
  const client = await linear.clientFor(linearConfig, app, log);
  const teams = await fetchTeams(client);
  if (!teams) return;
  const teamIds = await resolveTokens(teams, flags, linear, repo.id);
  if (!teamIds) return;
  const lanes = await askLanes(loaded, flags, teams, teamIds);
  if (!lanes) return;
  if (!(await cloneAndWrite(repo.url, repo.id, teamIds, lanes))) return;
  p.outro(
    `Next: restart \`aivi serve\` to index it; the HITL label \`${linearConfig.humanLabel}\` must exist in each mapped team. Hand delegation works whatever the lanes say.`,
  );
}
/** The team ids the tokens point to, asked before anything is cloned. No tokens, no ask. */
async function resolveAddTeams(
  loaded: LoadedConfig,
  tokens: string[],
  app: string | undefined,
  log: Awaited<ReturnType<typeof context>>['log'],
): Promise<string[]> {
  if (!tokens.length) return [];
  if (!loaded.config.linear) {
    throw new Error(
      'The Linear module is not configured in config.json (no `linear` block), so there is no app to ask for teams',
    );
  }
  const linear: Linear = await import('@aivi/linear');
  const client = await linear.clientFor(loaded.config.linear, app, log);
  return linear.resolveTeams(await client.listTeams(), tokens);
}

/** The script path: clone, and write the Linear mapping when teams were named. */
async function projectsAdd(
  url: string,
  values: {
    linear?: string | undefined;
    id?: string | undefined;
    app?: string | undefined;
    lane?: string[] | undefined;
    unlane?: string[] | undefined;
  },
): Promise<void> {
  const { loaded, log } = await context();
  const tokens = values.linear
    ? String(values.linear)
        .split(',')
        .map(token => token.trim())
        .filter(Boolean)
    : [];
  if (values.linear && !tokens.length) throw new Error('--linear wants at least one team key or id');
  const lanes = parseLaneFlags(values.lane ?? [], values.unlane ?? []);
  if (Object.keys(lanes).length && !tokens.length)
    throw new Error('--lane/--unlane need --linear: a lane routes to an app only inside a mapped team');
  // Resolve the teams before cloning: a wrong key must not leave a half-added project.
  const teamIds = await resolveAddTeams(loaded, tokens, values.app, log);
  const added = await addProject(configPath, url, values.id ? { id: values.id } : {});
  if (teamIds.length) {
    const written = await writeProjectLinear(configPath, added.id, {
      teams: teamIds,
      ...(Object.keys(lanes).length ? { lanes } : {}),
    });
    print({ ...added, linear: written });
    console.error(
      written.lanes
        ? 'Teams and lanes written; the listener works the mapped lanes and leaves the human ones alone.'
        : `Teams written. Until projects.${added.id}.linear.lanes maps lane → agent the listener delegates nothing; hand delegation works.`,
    );
  } else print(added);
  console.error('Restart `aivi serve` to index it; the host reads the projects directory at startup.');
}

export function registerProjects(program: Command): void {
  const projects = program
    .command('projects')
    .description('projects: the directories of <home>/projects')
    .helpGroup('Projects');
  projects
    .command('list')
    .description('Projects with their sources; removed ones keep their memory')
    .action(async () => {
      const { loaded } = await context();
      print(
        projectSummaries(loaded).map((project, i) => ({
          ...project,
          ...(project.removed ? {} : { directory: loaded.projects[i]!.directory }),
        })),
      );
    });
  projects
    .command('add <url>')
    .description('git clone into <home>/projects/<id>/source; that is the whole registration')
    .option('--id <id>', 'the project id; derived from the URL by default')
    .option(
      '--linear <teams>',
      'comma-separated Linear team keys or ids; also writes projects.<id>.linear.teams, resolving keys (PEC) to ids before anything is cloned',
    )
    .option('--app <id>', 'which Linear app to ask for teams when several are configured')
    .option('--lane <lane>', 'map a lane to an agent: "Dev:dev" or "Dev,Review:dev"; repeatable', collect)
    .option('--unlane <lane>', 'a lane unlaned is for humans, so the gateway never runs on it; repeatable', collect)
    .action(async (url, values) => {
      await projectsAdd(url, values);
    });
  projects
    .command('create [url]')
    .description('The one interactive command: asks URL, id, teams and lanes, then does projects add')
    .option('--id <id>', 'the project id; derived from the URL by default')
    .option('--linear <teams>', 'comma-separated Linear team keys or ids; a flag given skips its prompt')
    .option('--app <id>', 'which Linear app to ask for teams when several are configured')
    .option('--lane <lane>', 'map a lane to an agent: "Dev:dev" or "Dev,Review:dev"; repeatable', collect)
    .option('--unlane <lane>', 'a lane unlaned is for humans, so the gateway never runs on it; repeatable', collect)
    .action(async (url, values) => {
      await projectsCreate(url, values);
    });
  projects
    .command('remove <id>')
    .description('Delete the checkout; memory stays and the project is listed as removed')
    .action(async id => {
      print(await removeProject(configPath, id));
      console.error('Memory kept; the project is listed as removed until `aivi projects purge`. Restart `aivi serve`.');
    });
  projects
    .command('purge <id>')
    .description("Delete the project's memory (and checkout); without --confirm only shows what would go")
    .option('--confirm', 'really delete; memory cannot be recovered')
    .action(async (id, values) => {
      const purge = await purgeProject(configPath, id, { confirm: values.confirm ?? false });
      print(purge);
      if (!purge.purged) {
        console.error('Nothing deleted. Re-run with --confirm to delete these paths; memory cannot be recovered.');
        process.exitCode = 1;
      } else console.error('Restart `aivi serve` so the index forgets it.');
    });
}
