/** Linear's project-setup contributor, at its `./setupProject` subpath: it
 *  maps a new project to Linear teams and offers the project's lane array —
 *  the board's states in board order, each asked who works it. It clones
 *  nothing (a tracker has no checkout to give): it hands back the `linear`
 *  section core writes under the project, and the **core** `lanes` array
 *  core writes on the project. Everything Linear-specific — apps, teams,
 *  workflow states — lives here; core only knows this plugin serves the
 *  `tracker` role. */
import { getLogger, type Logger, type ProjectLaneInput } from '@aivi/core';
import { PluginSetupCancelled, type ProjectContributor, type ProjectSetupContext } from '@aivi/plugin';
import { type LinearTeam, resolveTeams } from './client.ts';
import type { LinearConfig } from './config.ts';
import { clientFor } from './tracker.ts';

const log = getLogger(['aivi', 'projects']);

/** The states the wizard asks about, in board order: deduped by name across
 *  the picked teams, and **closed states are gone** (ruled 2026-10-02 —
 *  Done, Canceled and Duplicate end work; the tracker recognizes them by
 *  type, they are not places in the workflow and never get written). A run
 *  that ends in the last configured lane moves nowhere: a person closes the
 *  ticket. Exported for the test that pins this ruling; the client already
 *  returns each team's states in board order (type group, then position). */
export function openStates(states: LinearTeam['states']): LinearTeam['states'] {
  const closed = new Set(['completed', 'canceled', 'duplicate']);
  const seen = new Set<string>();
  return states.filter(state => {
    if (closed.has(state.type) || seen.has(state.name)) return false;
    seen.add(state.name);
    return true;
  });
}

/** The lanes the queue question may offer (ruled 2026-10-02): **one**
 *  question after all lanes are configured, and its candidates are the
 *  lanes that could legally hold the queue — a queue lane must feed a
 *  worker lane, so a lane whose next works nobody is no candidate, and the
 *  last lane feeds nothing at all. And a lane that has an agent is **never**
 *  an option (ruled 2026-10-02): a queue is where people wait for a worker,
 *  not a worker lane itself — the queue runs between the human lanes and
 *  the working ones, like a real board's waiting column. Offering anything
 *  else would write a config the operator did not mean. Exported pure, like
 *  the closed-state ruling above it, so the wizard's rules are testable
 *  apart from prompts. */
export function queueCandidates(lanes: ProjectLaneInput[]): ProjectLaneInput[] {
  return lanes.filter(lane => lane.agent === undefined && lanes[lanes.indexOf(lane) + 1]?.agent !== undefined);
}

/** Mark the chosen queue lane. The queue answer is the wizard's later
 *  word, so a lane that just chose an agent gives it up — and says so out
 *  loud, because a lane silently losing its worker is not a wizard. The
 *  returned lines are what the caller logs; the marking itself follows
 *  core's load rules: a queue lane works none and writes nothing. */
export function markQueue(lanes: ProjectLaneInput[], chosen: string): string[] {
  const lane = lanes.find(l => l.name === chosen);
  if (!lane) return [];
  const said: string[] = [];
  if (lane.agent !== undefined) {
    delete lane.agent;
    said.push(`"${chosen}" works nobody then — it waits work instead`);
  }
  delete lane.worktree;
  lane.queue = true;
  return said;
}

/** The crossing to Linear the wizard needs: the teams it can list.
 *  Production is `clientFor`; a test answers with its own teams, because
 *  the wizard's questions, order and written config are the unit — the
 *  GraphQL round trip is client.test.ts's subject, and the live gate's. */
export type LinearTeamsClient = { listTeams(): Promise<LinearTeam[]> };
export type MakeTeamsClient = (config: LinearConfig, app: string | undefined, log: Logger) => LinearTeamsClient;

/** The app to ask for teams: one app is never asked of the person,
 *  several are. */
async function pickApp(ctx: ProjectSetupContext, appIds: string[]): Promise<string | undefined> {
  if (appIds.length <= 1) return undefined;
  const picked = await ctx.prompts.select({
    message: 'Ask which Linear app for teams',
    options: appIds.map(name => ({ value: name, label: name })),
  });
  if (ctx.prompts.isCancel(picked)) throw new PluginSetupCancelled('no app chosen');
  return picked as string;
}

/** The teams the app can see: the spinner says so, and a refusal ends the
 *  setup — a wizard that went on after a dead app would be writing blind. */
async function askedTeams(
  ctx: ProjectSetupContext,
  makeClient: MakeTeamsClient,
  config: LinearConfig,
  app: string | undefined,
): Promise<LinearTeam[]> {
  const spinner = ctx.prompts.spinner();
  spinner.start('Asking the app which teams it can see');
  let teams: LinearTeam[];
  try {
    teams = await makeClient(config, app, log).listTeams();
    spinner.stop(`The app can see ${teams.length} team${teams.length === 1 ? '' : 's'}`);
  } catch (error) {
    spinner.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (!teams.length) throw new Error('that Linear app sees no teams — a private team needs the app added to it');
  return teams;
}

/** Which of the visible teams may work here: a pick-list, never typing. */
async function pickTeams(ctx: ProjectSetupContext, teams: LinearTeam[]): Promise<string[]> {
  const pickedTeams = await ctx.prompts.multiselect({
    message: 'Which teams may work in this project?',
    options: teams.map(team => ({ value: team.id, label: `${team.key} — ${team.name}`, hint: team.id })),
    required: true,
  });
  if (ctx.prompts.isCancel(pickedTeams)) throw new PluginSetupCancelled('no teams picked');
  return pickedTeams as string[];
}

/** One prompt per lane: who works it. "-- None --" leaves a human lane:
 *  the orchestrator's silence, exactly as configured. */
async function askLanes(
  ctx: ProjectSetupContext,
  states: LinearTeam['states'],
  agentNames: string[],
): Promise<ProjectLaneInput[]> {
  const lanes: ProjectLaneInput[] = [];
  for (const state of states) {
    const answer = await ctx.prompts.select({
      message: `Which OpenCode agent works the "${state.name}" lane?`,
      options: [...agentNames.map(name => ({ value: name, label: name })), { value: '', label: '-- None --' }],
    });
    if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('lane setup incomplete');
    const agent = String(answer).trim();
    // A worked lane with git possible: does it work on the ticket's branch?
    // The worktree belongs to the branch, not to writing: a review lane
    // changes nothing yet must read the pull request's branch, and that
    // branch lives nowhere but a worktree — a run on a branch reuses the
    // worktree already holding it. Only a yes is written — core's default
    // is false, and a key stating the default is noise. "No" means the
    // project's own checkout; it is never a promise of read-only: that is
    // the agent file's own deny, never aivi's. Without a forge there are
    // no worktrees to promise, so nothing is asked.
    let worktree = false;
    if (agent && ctx.forgeConfigured) {
      const onBranch = await ctx.prompts.select({
        message: `Does work in the "${state.name}" lane happen on the ticket's branch (git worktree)?`,
        options: [
          { value: 'yes', label: "yes — on the ticket's branch, in its own worktree" },
          { value: 'no', label: 'no — in the project checkout itself' },
        ],
      });
      if (ctx.prompts.isCancel(onBranch)) throw new PluginSetupCancelled('lane setup incomplete');
      worktree = onBranch === 'yes';
    }
    lanes.push({ name: state.name, ...(agent ? { agent } : {}), ...(worktree ? { worktree } : {}) });
  }
  return lanes;
}

/** The queue: ONE question for the whole workflow (ruled 2026-10-02,
 *  after every lane is configured — never a per-lane ask). "-- None --"
 *  leaves the workflow without a queue lane, which is the old shape. */
async function askQueue(ctx: ProjectSetupContext, lanes: ProjectLaneInput[]): Promise<void> {
  const candidates = queueCandidates(lanes);
  if (candidates.length) {
    const answer = await ctx.prompts.select({
      message: 'Which lane waits with work while the working lanes are full (the queue)?',
      options: [
        ...candidates.map(lane => ({ value: lane.name, label: lane.name })),
        { value: '', label: '-- None --' },
      ],
    });
    if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('lane setup incomplete');
    const chosen = String(answer).trim();
    for (const line of chosen ? markQueue(lanes, chosen) : []) await ctx.prompts.log.message(line);
  } else if (lanes.length)
    await ctx.prompts.log.message(
      'no lane sits before a working lane, so nothing can wait for a slot — a queue lane comes later with a worker lane',
    );
}

/** The wizard, in its order: app, teams, the project's name, one agent per
 *  board state, then the queue over the finished lanes. Each step is its
 *  own question and its own honest failure; the whole is the ruling. */
function makeContributor(makeClient: MakeTeamsClient = clientFor): ProjectContributor {
  return {
    role: 'tracker',
    async setup(ctx) {
      const config = ctx.config as LinearConfig;
      const app = await pickApp(ctx, Object.keys(config.apps ?? {}));
      const teams = await askedTeams(ctx, makeClient, config, app);

      const teamIds = await pickTeams(ctx, teams);
      const chosen = teams.filter(team => teamIds.includes(team.id));

      // The name: a tracker offers the first team's key, lower-cased, unless an
      // earlier role (a forge) already settled it. A defaultValue, not just a
      // placeholder: Enter takes it *and says so* — a hint is display-only,
      // and an answered prompt that renders empty leaves the person guessing
      // what was taken.
      const suggested = (ctx.projectId ?? chosen[0]!.key).toLowerCase();
      const idAnswer = await ctx.prompts.text({
        message: "Project id — aivi's name for it; Linear never sees it.",
        placeholder: suggested,
        defaultValue: suggested,
      });
      if (ctx.prompts.isCancel(idAnswer)) throw new PluginSetupCancelled('no project id given');
      const id = (String(idAnswer).trim() || suggested).toLowerCase();

      // Lanes: core's ordered workflow (`projects.<id>.lanes`), and the board
      // is the order — the client returns a team's states in board order
      // (type group, then position).
      // A pick-list, never typing: the agents OpenCode can run as a primary
      // in this project's checkout. A service that answers with no agents
      // means something is broken — aivi always ships at least two — so the
      // setup says so and stops.
      const agentNames = await ctx.agents(id);
      if (!agentNames.length) throw new Error('Unable to configure lanes: there appear to be no agents available.');
      const lanes = await askLanes(ctx, openStates(chosen.flatMap(team => team.states)), agentNames);
      await askQueue(ctx, lanes);

      if (!lanes.length)
        await ctx.prompts.log.message(
          'these teams have no workflow states yet — lanes get written once the board has some',
        );

      const section: Record<string, unknown> = { teams: resolveTeams(teams, teamIds) };
      return { id, section, ...(lanes.length ? { lanes } : {}), cloned: false };
    },
  };
}

export const contributor = makeContributor();
export { makeContributor };
export default contributor;
