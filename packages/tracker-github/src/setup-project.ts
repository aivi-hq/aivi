/** The GitHub tracker's project-setup contributor, at its `./setupProject`
 *  subpath: it maps a new project to one projectsV2 board and the repositories
 *  whose issues feed it, and offers the project's lane array — the board's
 *  `Status` options in board order, each asked what kind of lane it is:
 *  Agent, Human or None (ruled by the human 2026-10-08; GitHub gives no
 *  state flag to guess from). It clones nothing
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
 *  a yes — and the field is then appended to every view that does not show it,
 *  operators included. The Status options aivi never creates or renames (D4).
 *
 *  A live aivi is asked as a choice, never presumed: silence offers "I started
 *  the server. Retry" or "Continue anyway", and continuing writes the mapping
 *  with the webhook's unproven state said. When one was there to watch, the
 *  wizard ends with the board probe: a test card pays the tracker's every
 *  mutation — issue, board add, Status move, Agent set, comment, reaction —
 *  the diary must echo each delivery back seal-verified (the reaction aside:
 *  paid and read back, no delivery subscribes), then cleanup says how the
 *  card rests in GitHub's real terms. */
import { readFile } from 'node:fs/promises';
import { errorMessage, getLogger, type Logger, type ProjectLaneInput } from '@aivi/core';
import { GITHUB_WEBHOOK_SECRET_ENV, type GitHubApp, githubApp } from '@aivi/github';
import {
  LANE_KIND,
  type LaneKind,
  laneKindLines,
  PluginSetupCancelled,
  type ProjectContributor,
  type ProjectSetupContext,
} from '@aivi/plugin';
import { GithubClient } from './client.ts';
import { AGENT_FIELD, githubSchema, STATUS_FIELD } from './config.ts';
import {
  aboutIssue,
  boardProbeVerdict,
  gateHost,
  hostIsUp,
  probeWindowMs,
  UNVERIFIED,
  waitForSignals,
} from './probe.ts';
import { GITHUB_WEBHOOK_PATH } from './tracker.ts';

const log = getLogger(['aivi', 'projects']);

/** One Status option, as GitHub answers it: an id, a name, and nothing else.
 *  **GitHub says nothing about what an option means** (probed live,
 *  2026-10-08): `ProjectV2SingleSelectFieldOption` carries
 *  `color, description, descriptionHTML, id, name, nameHTML` and no state
 *  flag — asking for `status` fails the whole read, because GraphQL rejects a
 *  query naming a field that does not exist. What a Status change does to an
 *  issue is the board's workflows, and a workflow's rule is not in the API
 *  either (`ProjectV2Workflow` answers id, name, number, enabled and dates).
 *  So the person decides what each option is: see `askLanes`. The org node id
 *  (on the board) is what a field creation is addressed to. */
export interface SetupBoardOption {
  id: string;
  name: string;
}

export interface SetupBoard {
  id: string;
  /** The board's number in the org — what the `tracker-github` section stores. */
  number: number;
  orgId: string;
  title: string;
  statusOptions: SetupBoardOption[];
  /** The `Status` field's own id — the probe mutates it directly. */
  statusFieldId: string;
  agentFieldId?: string;
  /** The `Agent` field's options; empty when the board has no such field yet. */
  agentOptions: { id: string; name: string }[];
}

/** The board probe's test card: what the wait must hear back (`asked` names
 *  the signals — probe.ts's `BOARD_SIGNALS` words), and everything cleanup
 *  needs. `statusSkipped` is a board with a single Status option, where no
 *  move can be shown: said as skipped, never as a failure. */
export interface ProbeHandles {
  ref: string;
  number: number;
  /** The issue's node id: board deliveries name no number, only this. */
  nodeId: string;
  itemId: string;
  projectId: string;
  agentFieldId: string;
  commentId: number;
  asked: string[];
  statusSkipped: boolean;
}

/** The wizard's crossing to GitHub, injectable like Linear's `MakeTeamsClient`:
 *  the questions, their order, and the written config are the unit under test;
 *  the GraphQL round trips are the live gate's. `delegate` is the `Agent`
 *  option name the app delegates as — its own login (D5). */
export interface GithubSetupClient {
  readonly delegate: string;
  readBoard(boardNumber: number): Promise<SetupBoard>;
  createAgentField(board: SetupBoard, delegate: string): Promise<void>;
  /** Append the `Agent` field to every view that does not show it — the
   *  mutation replaces, so each view is read first and written back whole.
   *  Answers the view names it changed; idempotent. */
  showAgentOnViews(board: SetupBoard, agentFieldId: string): Promise<string[]>;
  repositories(): Promise<{ id: string }[]>;
  ensureLabel(repo: string, label: string): Promise<void>;
  /** Pay the tracker's mutations on one throwaway issue: open, add to board,
   *  move Status, set Agent, comment, react — everything the tracker will
   *  ever do, and everything the diary must echo back (the reaction aside:
   *  paid and read back, no delivery subscribes). */
  openProbe(repo: string, board: SetupBoard): Promise<ProbeHandles>;
  /** Lay the test card to rest: Agent cleared, item archived, own reaction
   *  removed, comment deleted — then close, **unless GitHub's own workflow
   *  already closed it**: answers one line saying how the card rests, in
   *  GitHub's real terms. GitHub has no API to delete an issue. */
  closeProbe(handles: ProbeHandles): Promise<string>;
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
          ... on ProjectV2SingleSelectField { id name options { id name } }
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

/** The views and the fields each shows: the `fields` connection of a view is
 *  its **visible** fields, and (live, 2026-10-07) its nodes carry the field's
 *  own id under `ProjectV2FieldCommon` — the same ids `visibleFieldIds`
 *  takes back. */
const BOARD_VIEWS = /* GraphQL */ `
  query BoardViews($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        views(first: 20) { nodes {
          id name
          fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id } } }
        } }
      }
    }
  }
`;

/** `configuration` **replaces**, never appends: the visible list is read
 *  first and written back with the Agent field added (live, 2026-10-07 —
 *  `UpdateProjectV2ViewInput` takes no `projectId`). */
const SHOW_AGENT_FIELD = /* GraphQL */ `
  mutation ShowAgentField($viewId: ID!, $visibleFieldIds: [ID!]!) {
    updateProjectV2View(input: { id: $viewId, configuration: { visibleFieldIds: $visibleFieldIds } }) {
      projectV2View { id }
    }
  }
`;

/** The probe pays the tracker's own mutations directly — not through the
 *  module's client, whose caches and resolutions are exactly what the probe
 *  is there to prove. */
const PROBE_ADD_ITEM = /* GraphQL */ `
  mutation ProbeAddItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
  }
`;

const PROBE_SET_SELECT = /* GraphQL */ `
  mutation ProbeSetSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) { projectV2Item { id } }
  }
`;

const PROBE_CLEAR_SELECT = /* GraphQL */ `
  mutation ProbeClearSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    deleteProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
      projectV2Item { id }
    }
  }
`;

const PROBE_ARCHIVE_ITEM = /* GraphQL */ `
  mutation ProbeArchiveItem($projectId: ID!, $itemId: ID!) {
    archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { archivedItem { id } }
  }
`;

/** The production crossing: the home's app (D3 — the wizard and the module
 *  speak through one credential), read through the tracker's own client.
 *  Exported for the test that scripts GitHub's answers and proves the probe's
 *  own choices — which Status option it pays, the reaction it reads back, and
 *  whose close it reports. */
export class BoardSetupClient implements GithubSetupClient {
  private readonly app: GitHubApp;
  private readonly tracker: GithubClient;

  constructor(app: GitHubApp) {
    this.app = app;
    this.tracker = new GithubClient(app);
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
      statusOptions: (status.options ?? []).map((o: any) => ({ id: o.id, name: o.name })),
      statusFieldId: status.id,
      ...(agent ? { agentFieldId: agent.id } : {}),
      agentOptions: ((agent?.options ?? []) as any[]).map((o: any) => ({ id: o.id, name: o.name })),
    };
  }

  async createAgentField(board: SetupBoard, delegate: string): Promise<void> {
    await this.app.octokit.graphql(CREATE_AGENT_FIELD, { ownerId: board.orgId, option: delegate });
  }

  async showAgentOnViews(board: SetupBoard, agentFieldId: string): Promise<string[]> {
    const { organization } = await this.app.octokit.graphql<{ organization: any }>(BOARD_VIEWS, {
      owner: this.app.accountLogin,
      number: board.number,
    });
    const shown: string[] = [];
    for (const view of organization?.projectV2?.views?.nodes ?? []) {
      const ids = (view?.fields?.nodes ?? [])
        .map((field: any) => field?.id)
        .filter((id: unknown): id is string => typeof id === 'string');
      if (ids.includes(agentFieldId)) continue; // already visible: idempotent, write nothing
      await this.app.octokit.graphql(SHOW_AGENT_FIELD, { viewId: view.id, visibleFieldIds: [...ids, agentFieldId] });
      shown.push(String(view.name ?? view.id));
    }
    return shown;
  }

  repositories(): Promise<{ id: string }[]> {
    return this.app.repositories();
  }

  ensureLabel(repo: string, label: string): Promise<void> {
    return this.tracker.ensureLabel(repo, label);
  }

  async openProbe(repo: string, board: SetupBoard): Promise<ProbeHandles> {
    if (!board.agentFieldId)
      throw new Error('the board has no Agent field: the wizard creates one before the probe, never the probe');
    const issue = await this.tracker.createIssue(repo, {
      title: 'aivi projects add test — safe to ignore',
      body: 'A test card from `aivi projects add`: it proves GitHub’s deliveries reach this aivi. Closed and archived when the test ends.',
    });
    const { addProjectV2ItemById } = await this.app.octokit.graphql<{ addProjectV2ItemById: any }>(PROBE_ADD_ITEM, {
      projectId: board.id,
      contentId: issue.id,
    });
    const itemId: string = addProjectV2ItemById.item.id;
    const asked = ['issue opened', 'card added', 'Agent set', 'comment posted'];
    // Status: the next option in board order the card is not already on
    // (ruled by the human 2026-10-08 — no open/closed notion, GitHub has
    // none). A mutation that changes nothing posts nothing, and a signal
    // nobody paid for cannot land. A board's workflow may be wired to the
    // picked option and close the test card — accepted: the probe reports
    // what GitHub answers, not what aivi meant. A board with a single
    // Status option cannot show a move; skipping is not failing.
    const landing = await this.tracker.laneOn(issue.ref, board.number);
    const target = board.statusOptions.find(option => option.name !== landing?.name);
    let statusSkipped = true;
    if (target) {
      await this.app.octokit.graphql(PROBE_SET_SELECT, {
        projectId: board.id,
        itemId,
        fieldId: board.statusFieldId,
        optionId: target.id,
      });
      asked.push('Status moved');
      statusSkipped = false;
    }
    const agentOption = board.agentOptions.find(option => option.name === this.delegate);
    if (!agentOption)
      throw new Error(
        `the “${AGENT_FIELD}” field on board “${board.title}” has no option “${this.delegate}” — the app cannot be delegated there: add the option (or recreate the field) and run this again`,
      );
    await this.app.octokit.graphql(PROBE_SET_SELECT, {
      projectId: board.id,
      itemId,
      fieldId: board.agentFieldId,
      optionId: agentOption.id,
    });
    const comment = await this.tracker.createComment(issue.ref, 'aivi projects add test — safe to ignore.');
    // The reaction surface, paid and read back (ruled by the human
    // 2026-10-08). It is **not a signal**: GitHub posts `reaction` events
    // only to subscribers, and aivi subscribes to issue comment, issues and
    // projects v2 item — there is no delivery to wait for. Paying and
    // reading back proves the permission the tracker's status surface
    // (eyes, rocket) needs; cleanup takes the reaction off.
    await this.tracker.addReaction(issue.ref, 'eyes');
    const slash = issue.ref.indexOf('/');
    const hash = issue.ref.indexOf('#');
    const { data: reactions } = await this.app.octokit.rest.reactions.listForIssue({
      owner: issue.ref.slice(0, slash),
      repo: issue.ref.slice(slash + 1, hash),
      issue_number: issue.number,
      content: 'eyes',
      per_page: 100,
    });
    if (!reactions.some(reaction => reaction.user?.login === this.tracker.botLogin))
      throw new Error(
        `the eyes reaction did not land on ${issue.ref}: the app cannot react — check its repository permissions, then run this again`,
      );
    return {
      ref: issue.ref,
      number: issue.number,
      nodeId: issue.id,
      itemId,
      projectId: board.id,
      agentFieldId: board.agentFieldId,
      commentId: comment.id,
      asked,
      statusSkipped,
    };
  }

  async closeProbe(handles: ProbeHandles): Promise<string> {
    await this.app.octokit.graphql(PROBE_CLEAR_SELECT, {
      projectId: handles.projectId,
      itemId: handles.itemId,
      fieldId: handles.agentFieldId,
    });
    await this.app.octokit.graphql(PROBE_ARCHIVE_ITEM, { projectId: handles.projectId, itemId: handles.itemId });
    await this.tracker.removeOwnReaction(handles.ref, 'eyes');
    const [owner = '', rest = ''] = handles.ref.split('/');
    const repo = rest.split('#')[0] ?? '';
    await this.tracker.deleteComment(handles.ref, handles.commentId);
    // Report GitHub's answer, not aivi's intent (ruled by the human
    // 2026-10-08): a workflow wired to the Status option the probe picked
    // may have closed the card already — that is the operator's board
    // speaking, and the probe says so instead of claiming its own close.
    const { data: issue } = await this.app.octokit.rest.issues.get({ owner, repo, issue_number: handles.number });
    if (issue.state === 'closed')
      return `${handles.ref} rests closed by GitHub itself (${issue.state_reason ?? 'closed'}) — a workflow on the board closed the test card; aivi leaves it as GitHub left it`;
    await this.app.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: handles.number,
      state: 'closed',
      state_reason: 'not_planned',
    });
    return `${handles.ref} is closed (not planned), its card archived, its comment deleted — GitHub has no API to delete an issue`;
  }
}

const productionClient: MakeSetupClient = async setupLog => new BoardSetupClient(await githubApp({ log: setupLog }));

/** The lanes the queue question may offer (ruled 2026-10-02, mirrored from
 *  Linear's wizard): a queue lane must feed a worker lane, so a lane whose next
 *  works nobody is no candidate, the last lane feeds nothing at all, and a lane
 *  that has an agent is never an option — a queue is where people wait for a
 *  worker, not a worker lane itself. A **human** lane is a legal queue: that is
 *  what "used as a queue" means in the answer's own words. */
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
  let explained = false;
  for (const option of options) {
    // One log entry before the first question, never repeated per option
    // (ruled by the human 2026-10-08). GitHub gives no state flag and no
    // workflow rule, so the person decides — the note says why.
    if (!explained) {
      explained = true;
      await ctx.prompts.log.message(
        laneKindLines(
          'Aivi cannot tell what a board option means: GitHub keeps that in the board’s workflows, and their rules are not readable. You decide what each option is.',
        ).join('\n'),
      );
    }
    const picked = await ctx.prompts.select({
      message: `What kind of lane is the "${option.name}" option?`,
      options: [LANE_KIND.agent, LANE_KIND.human, LANE_KIND.none],
    });
    if (ctx.prompts.isCancel(picked)) throw new PluginSetupCancelled('lane setup incomplete');
    const kind = String(picked) as LaneKind;
    // "None": the option stays out of the array — aivi never reads it and
    // never moves a ticket into it.
    if (kind === LANE_KIND.none.value) continue;
    let agent = '';
    let worktree = false;
    if (kind === LANE_KIND.agent.value) {
      const answer = await ctx.prompts.select({
        message: `Which OpenCode agent works the "${option.name}" lane?`,
        options: agentNames.map(name => ({ value: name, label: name })),
      });
      if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('lane setup incomplete');
      agent = String(answer).trim();
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
    }
    // "Human": a bare lane. The orchestrator works nobody here; a finished
    // run may still move a ticket in, and after that aivi never touches it.
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
    // Enter takes board 1 (ruled by the human 2026-10-08). clack 1.x runs
    // `validate` on the raw input **before** `finalize` applies
    // `defaultValue` — so with a validate that refuses '', the default is
    // dead code (proven live: Enter showed the error, not board 1). The
    // empty answer must pass validation here, the default is folded in
    // below where it takes effect, and the placeholder shows what Enter
    // will take.
    placeholder: '1',
    defaultValue: '1',
    validate: value =>
      value === undefined || !value.trim() || /^[1-9]\d*$/.test(value.trim())
        ? undefined
        : 'the number at the end of the board URL',
  });
  if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('no board given');
  const boardNumber = Number(String(answer).trim() || '1');
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
      'that installation holds no repositories: select the repositories you want to use aivi in on the installation page',
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
 *  the tracker cannot work past. Answers the field's id, read back from the
 *  board rather than guessed: the probe pays real mutations and needs real ids. */
async function ensureAgentField(
  ctx: ProjectSetupContext,
  client: GithubSetupClient,
  board: SetupBoard,
): Promise<string> {
  if (board.agentFieldId) return board.agentFieldId;
  const yes = await ctx.prompts.confirm({
    message: `Create the “${AGENT_FIELD}” single-select field on board “${board.title}”, with the option “${client.delegate}”? Apps cannot be assignees on GitHub — this field is how aivi gets delegated.`,
  });
  if (ctx.prompts.isCancel(yes)) throw new PluginSetupCancelled('no answer about the Agent field');
  if (!yes)
    throw new Error(
      `board “${board.title}” has no “${AGENT_FIELD}” field and creating one was refused — the tracker cannot be delegated without it`,
    );
  await client.createAgentField(board, client.delegate);
  Object.assign(board, await client.readBoard(board.number));
  if (!board.agentFieldId)
    throw new Error(
      'the “Agent” field was created but the board still answers none — reload the board and run this again',
    );
  await ctx.prompts.log.message(
    `Created “${AGENT_FIELD}” on board “${board.title}” with the option “${client.delegate}”.`,
  );
  return board.agentFieldId;
}

/** The board probe (ruled 2026-10-07): one test card pays every mutation the
 *  tracker will ever make — open, board add, Status move to the next option
 *  in board order, Agent set, comment, reaction (paid and read back: no
 *  delivery subscribes) — and the diary must echo each delivery back,
 *  seal-verified. Then cleanup answers one line: how the card rests, in
 *  GitHub's real terms — a workflow's close is said as GitHub's, aivi's own
 *  close as aivi's, and the truth stands: GitHub has no API to delete an
 *  issue.
 *
 *  A missing signal is a verdict, not a throw — the mapping on disk is right;
 *  what is missing is GitHub's reach, and the line names what to check. A bad
 *  seal throws: a secret that does not match GitHub's breaks every delivery,
 *  so the wizard stops and says the remedy. */
async function probeBoard(
  ctx: ProjectSetupContext,
  client: GithubSetupClient,
  board: SetupBoard,
  repo: string,
): Promise<void> {
  const secret = process.env[GITHUB_WEBHOOK_SECRET_ENV];
  if (!secret)
    throw new Error(
      `no ${GITHUB_WEBHOOK_SECRET_ENV} in the home’s .env — run \`aivi add @aivi/tracker-github\` before mapping a project onto the board`,
    );
  const spinner = ctx.prompts.spinner();
  spinner.start(`Board probe in ${repo}: one test card, then GitHub’s answer`);
  const probe = await client.openProbe(repo, board);
  if (probe.statusSkipped)
    await ctx.prompts.log.message(
      'the board has a single Status option — a move cannot be shown, so the Status signal is skipped, not failed',
    );
  await ctx.prompts.log.message(
    'the reaction surface answered too: aivi’s eyes landed on the card and cleanup will clear it — reaction events are not subscribed, so there is no delivery to wait for',
  );
  spinner.message(`${probe.ref} is on the board — waiting for GitHub’s deliveries`);
  const windowMs = probeWindowMs();
  const { landed } = await ctx.withStore(store =>
    waitForSignals(
      store,
      {
        path: GITHUB_WEBHOOK_PATH,
        secret,
        windowMs,
        asked: probe.asked,
        about: aboutIssue(repo, probe.number, probe.nodeId),
      },
      0, // the about-filter is issue-scoped: a fresh issue cannot have history, so nothing old can false-land
      line => spinner.message(line),
    ),
  );
  const verdict = boardProbeVerdict(landed, probe.asked, windowMs);
  let rest = '';
  try {
    rest = await client.closeProbe(probe);
  } catch (error) {
    rest = `the test card could not be cleaned up: ${errorMessage(error)} — close it by hand: ${probe.ref}`;
  }
  if (verdict.pass) spinner.stop(`the board speaks — ${verdict.detail}`);
  else spinner.cancel(`board probe — ${verdict.detail}`);
  await ctx.prompts.log.message(rest);
}

/** The wizard, in its order: the health gate as a choice, the board, the
 *  delegate surface and its view visibility, the repositories, the project's
 *  name, what kind of lane each Status option is (agent, human, or none —
 *  ruled by the human 2026-10-08), the queue over the no-agent lanes,
 *  the human label in every mapped repository — and, when a live aivi was
 *  there to watch, the board probe last: it pays real mutations, so it comes
 *  after everything it tests. Each step is its own question and its own
 *  honest failure; the whole is the ruling. */
function makeContributor(makeClient: MakeSetupClient = productionClient): ProjectContributor {
  return {
    role: 'tracker',
    async setup(ctx) {
      const config = githubSchema.parse(ctx.config);
      // The gate asks the live aivi, and its URL lives in config.json's host
      // block — not in the plugin's block the context carries.
      const verify = await gateHost(ctx.prompts, async () => {
        try {
          const raw = JSON.parse(await readFile(ctx.configPath, 'utf8')) as {
            host?: { bind?: string; port?: number };
          };
          return hostIsUp(ctx.fetch, raw.host);
        } catch {
          return false; // no readable config.json answers nothing: the gate says so as silence
        }
      });
      const client = await makeClient(log);

      const board = await askedBoard(ctx, client);
      const agentFieldId = await ensureAgentField(ctx, client, board);
      const shown = await client.showAgentOnViews(board, agentFieldId);
      await ctx.prompts.log.message(
        shown.length
          ? `“${AGENT_FIELD}” now shows on: ${shown.join(', ')}.`
          : `“${AGENT_FIELD}” already shows on the board’s views.`,
      );
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
      const lanes = await askLanes(ctx, board.statusOptions, agentNames);
      await askQueue(ctx, lanes);

      if (!lanes.length)
        await ctx.prompts.log.message(
          'no lanes were written — the board had no Status options, or every option was answered “None” — so aivi works no tickets until lanes exist',
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

      // The probe last: it pays real mutations and needs the whole mapping in
      // place to mean anything. Without a live aivi there is no diary to
      // watch, and the unverified fact is said in the same words the `aivi
      // add` installer uses.
      if (verify) await probeBoard(ctx, client, board, repos[0]!);
      else await ctx.prompts.log.message(UNVERIFIED);

      return { id, section: { board: board.number, repos }, ...(lanes.length ? { lanes } : {}), cloned: false };
    },
  };
}

export const contributor = makeContributor();
export { makeContributor };
export default contributor;
