/** The GitHub tracker's project-setup contributor, at its `./setupProject`
 *  subpath: it maps a new project to one projectsV2 board and the repositories
 *  whose issues feed it, and offers the project's lane array — the board's
 *  `Status` options in board order, each asked who works it. It clones nothing
 *  (a tracker has no checkout to give): it hands back the `tracker-github`
 *  section core writes under the project, and the **core** `lanes` array core
 *  writes on the project. Everything GitHub-specific — the board, its fields,
 *  the human label — lives here; core only knows this plugin serves the
 *  `tracker` role.
 *
 *  The board is never enumerated: listing an org's boards needs admin rights
 *  the installation does not have (and must not). The person pastes the number
 *  from the board's URL and the app proves it can read that board — a board it
 *  cannot read is said with the permission that unlocks it. The `Agent` field
 *  is aivi's own surface (D5: apps cannot be assignees, proven 403): when the
 *  board lacks one, creating it is **asked** — a person's board changes only on
 *  a yes. The Status options aivi never creates or renames (D4). */
import { getLogger, type Logger, type ProjectLaneInput } from '@aivi/core';
import { type GitHubApp, githubApp } from '@aivi/github';
import { PluginSetupCancelled, type ProjectContributor, type ProjectSetupContext } from '@aivi/plugin';
import { GithubClient } from './client.ts';
import { AGENT_FIELD, githubSchema, STATUS_FIELD } from './config.ts';

const log = getLogger(['aivi', 'projects']);

/** The board as the wizard reads it: GitHub's own `status` on each option is
 *  what tells a closed state from a lane, and the org node id is what a field
 *  creation is addressed to. */
export interface SetupBoardOption {
  id: string;
  name: string;
  status: string;
}

export interface SetupBoard {
  id: string;
  /** The board's number in the org — what the `tracker-github` section stores. */
  number: number;
  orgId: string;
  title: string;
  statusOptions: SetupBoardOption[];
  agentFieldId?: string;
}

/** The wizard's crossing to GitHub, injectable like Linear's `MakeTeamsClient`:
 *  the questions, their order, and the written config are the unit under test;
 *  the GraphQL round trips are the live gate's. `delegate` is the `Agent`
 *  option name the app delegates as — its own login (D5). */
export interface GithubSetupClient {
  readonly delegate: string;
  readBoard(boardNumber: number): Promise<SetupBoard>;
  createAgentField(board: SetupBoard, delegate: string): Promise<void>;
  repositories(): Promise<{ id: string }[]>;
  ensureLabel(repo: string, label: string): Promise<void>;
}
export type MakeSetupClient = (log: Logger) => Promise<GithubSetupClient>;

const BOARD_SETUP = /* GraphQL */ `
  query BoardSetup($owner: String!, $number: Int!) {
    organization(login: $owner) {
      id
      projectV2(number: $number) {
        id
        title
        fields(first: 60) { nodes {
          ... on ProjectV2SingleSelectField { id name options { id name status } }
        } }
      }
    }
  }
`;

const CREATE_AGENT_FIELD = /* GraphQL */ `
  mutation CreateAgentField($ownerId: ID!, $option: String!) {
    createProjectV2Field(
      input: { projectOwnerId: $ownerId, dataType: SINGLE_SELECT, name: "Agent", singleSelectOptions: [{ name: $option }] }
    ) { projectV2Field { ... on ProjectV2SingleSelectField { id name } } }
  }
`;

/** The production crossing: the home's app (D3 — the wizard and the module
 *  speak through one credential), read through the tracker's own client. */
class BoardSetupClient implements GithubSetupClient {
  private readonly app: GitHubApp;

  constructor(app: GitHubApp) {
    this.app = app;
  }

  get delegate(): string {
    return this.app.appSlug;
  }

  async readBoard(boardNumber: number): Promise<SetupBoard> {
    const { organization } = await this.app.octokit.graphql<{ organization: any }>(BOARD_SETUP, {
      owner: this.app.accountLogin,
      number: boardNumber,
    });
    if (!organization)
      throw new Error(
        `${this.app.accountLogin} answers nothing for the app: the installation is not on that organization`,
      );
    const project = organization.projectV2;
    if (!project)
      throw new Error(
        `board ${boardNumber} is not visible to the app in ${this.app.accountLogin}: check the number at the end of the board URL, and that the installation has “Organization projects: Read & write”`,
      );
    let status: any;
    let agent: any;
    for (const field of project.fields?.nodes ?? [])
      if (field?.name === STATUS_FIELD) status = field;
      else if (field?.name === AGENT_FIELD) agent = field;
    if (!status)
      throw new Error(
        `board “${project.title}” has no “${STATUS_FIELD}” single-select field — lanes map onto its options and aivi never creates one (add the field on the board, or pick the board that has it)`,
      );
    return {
      id: project.id,
      number: boardNumber,
      orgId: organization.id,
      title: project.title,
      statusOptions: (status.options ?? []).map((o: any) => ({
        id: o.id,
        name: o.name,
        status: String(o.status ?? 'TODO'),
      })),
      ...(agent ? { agentFieldId: agent.id } : {}),
    };
  }

  async createAgentField(board: SetupBoard, delegate: string): Promise<void> {
    await this.app.octokit.graphql(CREATE_AGENT_FIELD, { ownerId: board.orgId, option: delegate });
  }

  repositories(): Promise<{ id: string }[]> {
    return this.app.repositories();
  }

  ensureLabel(repo: string, label: string): Promise<void> {
    return new GithubClient(this.app).ensureLabel(repo, label);
  }
}

const productionClient: MakeSetupClient = async setupLog => new BoardSetupClient(await githubApp({ log: setupLog }));

/** Closed Status options are not lanes — GitHub's spelling of the ruling that
 *  removed Linear's Done, Canceled and Duplicate (2026-10-02): GitHub's own
 *  `status` says `DONE` for the options that end work. A run that ends in the
 *  last configured lane moves nowhere: a person closes the ticket. Deduped by
 *  name keeping the first, like the Linear rule. Exported pure for the test
 *  that pins the ruling. */
export function openStatusOptions(options: SetupBoardOption[]): SetupBoardOption[] {
  const seen = new Set<string>();
  const open: SetupBoardOption[] = [];
  for (const option of options) {
    if (option.status === 'DONE' || seen.has(option.name)) continue;
    seen.add(option.name);
    open.push(option);
  }
  return open;
}

/** The lanes the queue question may offer (ruled 2026-10-02, mirrored from
 *  Linear's wizard): a queue lane must feed a worker lane, so a lane whose next
 *  works nobody is no candidate, the last lane feeds nothing at all, and a lane
 *  that has an agent is never an option — a queue is where people wait for a
 *  worker, not a worker lane itself. */
export function queueCandidates(lanes: ProjectLaneInput[]): ProjectLaneInput[] {
  return lanes.filter(lane => lane.agent === undefined && lanes[lanes.indexOf(lane) + 1]?.agent !== undefined);
}

/** Mark the chosen queue lane. The queue answer is the wizard's later word, so
 *  a lane that just chose an agent gives it up — and says so out loud. The
 *  returned lines are what the caller logs. */
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

/** The project name a board title suggests: GitHub's `My Board` becomes aivi's
 *  `my-board`, the shape a project directory takes (the forge's rule for repo
 *  names, turned on a title). Anything the id rule does not allow becomes a
 *  dash, and a name that no longer starts with a letter keeps one. */
export function boardSuggestion(title: string): string {
  const folded = title.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return /^[a-z]/.test(folded) ? folded : `p-${folded}`;
}

/** One prompt per lane: who works it. "-- None --" leaves a human lane: the
 *  orchestrator's silence, exactly as configured. The worktree question is the
 *  forge's branch question, word for word, so both wizards read alike. */
async function askLanes(
  ctx: ProjectSetupContext,
  options: SetupBoardOption[],
  agentNames: string[],
): Promise<ProjectLaneInput[]> {
  const lanes: ProjectLaneInput[] = [];
  for (const option of options) {
    const answer = await ctx.prompts.select({
      message: `Which OpenCode agent works the "${option.name}" lane?`,
      options: [...agentNames.map(name => ({ value: name, label: name })), { value: '', label: '-- None --' }],
    });
    if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('lane setup incomplete');
    const agent = String(answer).trim();
    let worktree = false;
    if (agent && ctx.forgeConfigured) {
      const onBranch = await ctx.prompts.select({
        message: `Does work in the "${option.name}" lane happen on the ticket's branch (git worktree)?`,
        options: [
          { value: 'yes', label: "yes — on the ticket's branch, in its own worktree" },
          { value: 'no', label: 'no — in the project checkout itself' },
        ],
      });
      if (ctx.prompts.isCancel(onBranch)) throw new PluginSetupCancelled('lane setup incomplete');
      worktree = onBranch === 'yes';
    }
    lanes.push({ name: option.name, ...(agent ? { agent } : {}), ...(worktree ? { worktree } : {}) });
  }
  return lanes;
}

/** The queue: ONE question for the whole workflow (ruled 2026-10-02, after
 *  every lane is configured — never a per-lane ask). "-- None --" leaves the
 *  workflow without a queue lane, which is the old shape. */
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

/** The board the wizard reads before anything else: the number is typed (the
 *  pick-list would need admin rights the grant does not have), the read is the
 *  proof. A refusal ends the setup — a wizard that went on after a board it
 *  cannot read would be writing blind. */
async function askedBoard(ctx: ProjectSetupContext, client: GithubSetupClient): Promise<SetupBoard> {
  const answer = await ctx.prompts.text({
    message: 'The board number — the number at the end of the board URL (github.com/orgs/<org>/projects/1 is board 1)',
    placeholder: 'e.g. 1',
    validate: value =>
      value !== undefined && /^[1-9]\d*$/.test(value.trim()) ? undefined : 'the number at the end of the board URL',
  });
  if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('no board given');
  const boardNumber = Number(String(answer).trim());
  const spinner = ctx.prompts.spinner();
  spinner.start(`Reading board ${boardNumber}`);
  try {
    const board = await client.readBoard(boardNumber);
    spinner.stop(`Board “${board.title}” has ${board.statusOptions.length} Status options`);
    return board;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.error(message);
    throw error;
  }
}

/** The repositories whose issues feed this project: a pick-list of the real
 *  grant, never typing. */
async function pickRepos(ctx: ProjectSetupContext, client: GithubSetupClient): Promise<string[]> {
  const spinner = ctx.prompts.spinner();
  spinner.start('Asking the app which repositories it can see');
  let granted: { id: string }[];
  try {
    granted = await client.repositories();
    spinner.stop(`The app can see ${granted.length} repositor${granted.length === 1 ? 'y' : 'ies'}`);
  } catch (error) {
    spinner.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (!granted.length)
    throw new Error(
      'that installation holds no repositories: add the repositories aivi works on the installation page',
    );
  const picked = await ctx.prompts.multiselect({
    message: 'Which repositories feed this project?',
    options: granted.map(repo => ({ value: repo.id, label: repo.id })),
    required: true,
  });
  if (ctx.prompts.isCancel(picked)) throw new PluginSetupCancelled('no repositories picked');
  return picked as string[];
}

/** The delegate surface (D5): when the board has no `Agent` field, creating one
 *  is asked — a person's board changes only on a yes — and the no is a decision
 *  the tracker cannot work past. */
async function ensureAgentField(ctx: ProjectSetupContext, client: GithubSetupClient, board: SetupBoard): Promise<void> {
  if (board.agentFieldId) return;
  const yes = await ctx.prompts.confirm({
    message: `Create the “${AGENT_FIELD}” single-select field on board “${board.title}”, with the option “${client.delegate}”? Apps cannot be assignees on GitHub — this field is how aivi gets delegated.`,
  });
  if (ctx.prompts.isCancel(yes)) throw new PluginSetupCancelled('no answer about the Agent field');
  if (!yes)
    throw new Error(
      `board “${board.title}” has no “${AGENT_FIELD}” field and creating one was refused — the tracker cannot be delegated without it`,
    );
  await client.createAgentField(board, client.delegate);
  await ctx.prompts.log.message(
    `Created “${AGENT_FIELD}” on board “${board.title}”. Routing reads the field, not the view: show it on your views if you want to see it.`,
  );
}

/** The wizard, in its order: board, delegate surface, repositories, the
 *  project's name, one agent per open Status option, the queue over the
 *  finished lanes, then the human label in every mapped repository. Each step
 *  is its own question and its own honest failure; the whole is the ruling. */
function makeContributor(makeClient: MakeSetupClient = productionClient): ProjectContributor {
  return {
    role: 'tracker',
    async setup(ctx) {
      const config = githubSchema.parse(ctx.config);
      const client = await makeClient(log);

      const board = await askedBoard(ctx, client);
      await ensureAgentField(ctx, client, board);
      const repos = await pickRepos(ctx, client);

      // The name: a tracker offers the board's title, folded, unless an earlier
      // role (a forge) already settled it. A defaultValue, not just a
      // placeholder: Enter takes it *and says so*.
      const suggested = (ctx.projectId ?? boardSuggestion(board.title)).toLowerCase();
      const idAnswer = await ctx.prompts.text({
        message: "Project id — aivi's name for it; GitHub never sees it.",
        placeholder: suggested,
        defaultValue: suggested,
      });
      if (ctx.prompts.isCancel(idAnswer)) throw new PluginSetupCancelled('no project id given');
      const id = (String(idAnswer).trim() || suggested).toLowerCase();

      // Lanes: core's ordered workflow (`projects.<id>.lanes`), and the board
      // is the order — Status options arrive in board order already.
      const agentNames = await ctx.agents(id);
      if (!agentNames.length) throw new Error('Unable to configure lanes: there appear to be no agents available.');
      const lanes = await askLanes(ctx, openStatusOptions(board.statusOptions), agentNames);
      await askQueue(ctx, lanes);

      if (!lanes.length)
        await ctx.prompts.log.message(
          'this board has no open Status options yet — lanes get written once the board has some',
        );

      // The human label: unlike Linear, where it must pre-exist, GitHub
      // repositories get it here — a failed closing and a hand-delegation
      // refusal mark with it, and it must be there before the first failure.
      for (const repo of repos) {
        try {
          await client.ensureLabel(repo, config.humanLabel);
        } catch (error) {
          throw new Error(
            `label “${config.humanLabel}” could not be created in ${repo}: ${error instanceof Error ? error.message : String(error)} — the app needs Issues: Read & write on that repository`,
          );
        }
      }
      await ctx.prompts.log.message(`“${config.humanLabel}” is ready in ${repos.join(', ')}.`);

      return { id, section: { board: board.number, repos }, ...(lanes.length ? { lanes } : {}), cloned: false };
    },
  };
}

export const contributor = makeContributor();
export { makeContributor };
export default contributor;
