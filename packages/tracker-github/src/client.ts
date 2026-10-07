/** Everything GitHub-shaped that the tracker asks of the API: the board
 *  reads and writes (Status and the `Agent` field), the issue facts, the
 *  comment trail, labels and reactions. Authentication is `@aivi/github`'s —
 *  one app, one installation, octokit's cached installation token — this file
 *  is only the queries and what they answer.
 *
 *  The issue id in aivi's hands is `owner/repo#47`, the words a person
 *  types; the GraphQL node ids live here and nowhere above. Reads that lag
 *  their writes (live, 2026-10-07: a re-read right after a mutation answered
 *  the old value) are not trusted — the mutation's own answer is the truth,
 *  and the board's own webhook is the catch-up.
 */

import type { Logger } from '@aivi/core';
import { GITHUB_WEBHOOK_SECRET_ENV, type GitHubApp, githubApp } from '@aivi/github';
import { ConfigurationError } from '@aivi/plugin';
import { AGENT_FIELD, STATUS_FIELD } from './config.ts';

/** `owner/repo#47` — the issue id aivi speaks, parsed. `owner` and `name`
 *  are the two words octokit asks for; the full id is the string it came from. */
export interface IssueRef {
  owner: string;
  name: string;
  number: number;
}

export const REPO_ISSUE = /^([^/]+)\/([^/#]+)#(\d+)$/;

export function issueRef(id: string): IssueRef {
  const found = REPO_ISSUE.exec(id.trim());
  if (!found) throw new Error(`"${id}" is not a GitHub issue id (owner/repo#number)`);
  return { owner: found[1]!, name: found[2]!, number: Number(found[3]) };
}

export const repoIssueId = (owner: string, name: string, number: number): string => `${owner}/${name}#${number}`;

/** One single-select value of a board item: the option's name and id, and
 *  which field it answers (`Status`, `Agent`). */
export interface ItemSelectValue {
  field: string;
  name: string;
  optionId: string;
}

/** One board item of an issue: the board's org-level number, the item's node
 *  id, and its single-select values. */
export interface BoardItem {
  itemId: string;
  boardNumber: number;
  values: ItemSelectValue[];
}

/** A dependency as the issue reports it. */
export interface IssueDependency {
  id: string; // owner/repo#n
  completed: boolean;
}

/** An issue as GitHub answers it — the client's own shape, before the
 *  adapter translates. `projectItems` carries the board facts; a caller who
 *  cares about one board filters by `boardNumber`. */
export interface GithubIssue {
  id: string; // GraphQL node id — what the board mutations need
  ref: string; // owner/repo#n
  repo: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: { id: string; name: string }[];
  assignees: { id: string; name: string }[];
  projectItems: BoardItem[];
  blockedBy: IssueDependency[];
}

/** A comment as GitHub answers it. */
export interface GithubComment {
  id: number;
  author: string | null;
  authorIsBot: boolean;
  body: string;
  at: string;
}

/** The board's own fields, resolved once per start (the options a walk
 *  matches lanes against change when a person changes them, and a restart is
 *  when aivi learns of that): the node ids of `Status` and `Agent` and their
 *  options, in board order. */
export interface BoardFields {
  projectId: string;
  number: number;
  statusFieldId: string;
  statusOptions: { id: string; name: string }[];
  agentFieldId: string;
  agentOptions: { id: string; name: string }[];
}

/** What the board mutations need to name a value: the board, its item, and
 *  the field. Absent board item is said, never guessed at. */
const itemOn = (issue: GithubIssue, boardNumber: number): BoardItem | undefined =>
  issue.projectItems.find(i => i.boardNumber === boardNumber);

const optionNamed = (options: { id: string; name: string }[], name: string): string | undefined =>
  options.find(o => o.name === name)?.id;

/** The dependency verdict in GitHub's words: closed is closed, whatever the
 *  reason — a `not_planned` blocker holds nothing back any more than a
 *  `completed` one does. */
export const dependencyCompleted = (state: string): boolean => state === 'closed';

/** Whether GitHub says the thing **does not exist** rather than "try
 *  again": a deleted issue answers its comments, its board item and its own
 *  node with 404 (REST) or `Could not resolve to a Node` (GraphQL). A
 *  closing owed to such a surface is dropped, not retried — the Linear
 *  tracker learned that on a grave (live, 2026-10-06). Anything else —
 *  a 502, a rate limit — is a retry. */
export const isGoneError = (error: unknown): boolean => {
  const e = error as { status?: number; message?: string } | undefined;
  if (e?.status === 404 || e?.status === 410) return true;
  return typeof e?.message === 'string' && e.message.includes('Could not resolve to a Node');
};

const ISSUE_FACTS = /* GraphQL */ `
  query IssueFacts($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id databaseId title body url state stateReason
        labels(first: 50) { nodes { id name } }
        assignees(first: 10) { nodes { id login } }
        projectItems(first: 50, archived: false) { nodes {
          id
          project { databaseId }
          fieldValues(first: 30) { nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name optionId
              field { ... on ProjectV2SingleSelectField { name } }
            }
          } }
        } }
        blockedBy(first: 20) { nodes {
          databaseId state stateReason
          repository { owner { login } name }
        } }
      }
    }
  }
`;

const OPEN_ISSUES = /* GraphQL */ `
  query OpenIssues($owner: String!, $repo: String!, $first: Int!) {
    repository(owner: $owner, name: $repo) {
      issues(states: [OPEN], first: $first, orderBy: { field: CREATED, direction: DESC }) {
        nodes {
          id databaseId title body url state stateReason
          labels(first: 20) { nodes { id name } }
          assignees(first: 10) { nodes { id login } }
          projectItems(first: 20, archived: false) { nodes {
            id
            project { databaseId }
            fieldValues(first: 30) { nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name optionId
                field { ... on ProjectV2SingleSelectField { name } }
              }
            } }
          } }
          blockedBy(first: 10) { nodes {
            databaseId state stateReason
            repository { owner { login } name }
          } }
        }
      }
    }
  }
`;

const BOARD_FIELDS = /* GraphQL */ `
  query BoardFields($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 60) { nodes {
          ... on ProjectV2Field { id name databaseId }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        } }
      }
    }
  }
`;

const ADD_ITEM = /* GraphQL */ `
  mutation AddItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
  }
`;

const NODE_REF = /* GraphQL */ `
  query NodeRef($id: ID!) {
    node(id: $id) {
      ... on Issue {
        databaseId
        repository { owner { login } name }
      }
    }
  }
`;

const SET_SELECT = /* GraphQL */ `
  mutation SetSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) { projectV2Item { id } }
  }
`;

const CLEAR_SELECT = /* GraphQL */ `
  mutation ClearSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    deleteProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
      projectV2Item { id }
    }
  }
`;

/** Map one GraphQL issue node into the client's shape. The board values ride
 *  as `projectItems`; everything GitHub-flavored is translated to aivi words
 *  here and stops existing above this file. */
function mapIssue(owner: string, name: string, node: Record<string, any>): GithubIssue {
  const repo = `${owner}/${name}`;
  const ref = repoIssueId(owner, name, node.databaseId);
  return {
    id: node.id,
    ref,
    repo,
    number: node.databaseId,
    title: node.title,
    body: node.body ?? null,
    url: node.url,
    state: node.state === 'CLOSED' ? 'closed' : 'open',
    stateReason: node.stateReason ? String(node.stateReason).toLowerCase() : null,
    labels: (node.labels?.nodes ?? []).map((l: any) => ({ id: l.id, name: l.name })),
    assignees: (node.assignees?.nodes ?? []).map((a: any) => ({ id: a.id, name: a.login })),
    projectItems: (node.projectItems?.nodes ?? []).map((item: any) => ({
      itemId: item.id,
      boardNumber: Number(item.project?.databaseId),
      values: (item.fieldValues?.nodes ?? [])
        .filter((v: any) => v?.field?.name)
        .map((v: any) => ({ field: v.field.name, name: v.name, optionId: v.optionId })),
    })),
    blockedBy: (node.blockedBy?.nodes ?? []).map((d: any) => ({
      id: repoIssueId(d.repository.owner.login, d.repository.name, d.databaseId),
      completed: dependencyCompleted(d.state === 'CLOSED' ? 'closed' : 'open'),
    })),
  };
}

/** The tracker's GitHub client: the app's octokit (from `@aivi/github`) with
 *  the board's queries and the issue REST on it. One per process, shared
 *  with nothing else: the forge's pull-request facts never come through here. */
export class GithubClient {
  private readonly app: GitHubApp;
  private readonly boards = new Map<number, BoardFields>();

  constructor(app: GitHubApp) {
    this.app = app;
  }

  /** Whose account made the grant (the org whose boards aivi reads). */
  get org(): string {
    return this.app.accountLogin;
  }

  /** The app's own login, GitHub's way: the bot suffix rides every post, and
   *  inbound filtering reads it back. */
  get botLogin(): string {
    return `${this.app.appSlug}[bot]`;
  }

  /** The `Agent` option aivi delegates to: the option named for the app
   *  itself (D5) — the same word on every board, resolved to a per-board
   *  option id on use. */
  get delegateName(): string {
    return this.app.appSlug;
  }

  get octokit(): GitHubApp['octokit'] {
    return this.app.octokit;
  }

  /** Resolve a board's `Status` and `Agent` fields and their options, once.
   *  A board missing either is said by name — aivi never creates or renames
   *  a Status option (D4), and the `Agent` field is setup's job. */
  async boardFields(boardNumber: number): Promise<BoardFields> {
    const known = this.boards.get(boardNumber);
    if (known) return known;
    const { organization } = await this.app.octokit.graphql<{ organization: any }>(BOARD_FIELDS, {
      owner: this.org,
      number: boardNumber,
    });
    const project = organization?.projectV2;
    if (!project) throw new Error(`board ${boardNumber} is not visible to the app in ${this.org}`);
    let status: any;
    let agent: any;
    for (const field of project.fields?.nodes ?? [])
      if (field?.name === STATUS_FIELD) status = field;
      else if (field?.name === AGENT_FIELD) agent = field;
    if (!status)
      throw new Error(
        `board ${boardNumber} of ${this.org} has no "${STATUS_FIELD}" single-select field; lanes map onto its options and aivi never creates them`,
      );
    if (!agent)
      throw new Error(
        `board ${boardNumber} of ${this.org} has no "${AGENT_FIELD}" single-select field; run the project setup — the Agent field is aivi's delegate surface (apps cannot be assignees)`,
      );
    const fields: BoardFields = {
      projectId: project.id,
      number: boardNumber,
      statusFieldId: status.id,
      statusOptions: (status.options ?? []).map((o: any) => ({ id: o.id, name: o.name })),
      agentFieldId: agent.id,
      agentOptions: (agent.options ?? []).map((o: any) => ({ id: o.id, name: o.name })),
    };
    this.boards.set(boardNumber, fields);
    return fields;
  }

  /** The board's Status options, in board order — the lane names a mapping
   *  is validated against. */
  async laneOptions(boardNumber: number): Promise<{ id: string; name: string }[]> {
    return (await this.boardFields(boardNumber)).statusOptions;
  }

  async issue(id: string): Promise<GithubIssue> {
    const { owner, name, number } = issueRef(id);
    const { repository } = await this.app.octokit.graphql<{ repository: any }>(ISSUE_FACTS, {
      owner,
      repo: name,
      number,
    });
    if (!repository?.issue) throw new Error(`${id} answers nothing: the issue is gone or the app was not given it`);
    return mapIssue(owner, name, repository.issue);
  }

  /** A repository's open issues, newest created first, each with its board
   *  facts: the walk's read (the plan's per-issue `projectItems`, paid in one
   *  round trip). Capped; a truncated read is said, never silently short. */
  async openIssues(repo: string, cap = 100): Promise<{ issues: GithubIssue[]; truncated: boolean }> {
    const [owner, name] = repo.split('/');
    const { repository } = await this.app.octokit.graphql<{ repository: any }>(OPEN_ISSUES, {
      owner,
      repo: name,
      first: cap,
    });
    const nodes = repository?.issues?.nodes ?? [];
    return { issues: nodes.map((n: any) => mapIssue(owner!, name!, n)), truncated: nodes.length >= cap };
  }

  /** The issue's lane on one board, read from its item: undefined when the
   *  issue is not on that board at all. */
  async laneOn(id: string, boardNumber: number): Promise<{ name: string; optionId: string } | undefined> {
    const issue = await this.issue(id);
    return this.laneOf(issue, boardNumber);
  }

  laneOf(issue: GithubIssue, boardNumber: number): { name: string; optionId: string } | undefined {
    const item = itemOn(issue, boardNumber);
    const status = item?.values.find(v => v.field === STATUS_FIELD);
    return status && status.name ? { name: status.name, optionId: status.optionId } : undefined;
  }

  /** The issue's `Agent` value on one board: the option's name, or undefined
   *  when nobody speaks for the ticket. */
  agentOn(issue: GithubIssue, boardNumber: number): string | undefined {
    const item = itemOn(issue, boardNumber);
    const agent = item?.values.find(v => v.field === AGENT_FIELD);
    return agent && agent.name ? agent.name : undefined;
  }

  /** Move an issue into a board's Status option: onto the board first (the
   *  add is idempotent — a re-drive lands as nothing), then the option. The
   *  mutation's own answer is the truth; a re-read right after lags. */
  async setLane(id: string, boardNumber: number, lane: string): Promise<void> {
    const fields = await this.boardFields(boardNumber);
    const optionId = optionNamed(fields.statusOptions, lane);
    if (!optionId)
      throw new Error(
        `board ${boardNumber} of ${this.org} has no Status option "${lane}": map the lane to an option that exists — aivi never creates one`,
      );
    const issue = await this.issue(id);
    let item = itemOn(issue, boardNumber);
    if (!item) {
      const { addProjectV2ItemById } = await this.app.octokit.graphql<{ addProjectV2ItemById: any }>(ADD_ITEM, {
        projectId: fields.projectId,
        contentId: issue.id,
      });
      item = { itemId: addProjectV2ItemById.item.id, boardNumber, values: [] };
    }
    if (item.values.find(v => v.field === STATUS_FIELD)?.name === lane) return; // already there
    await this.app.octokit.graphql(SET_SELECT, {
      projectId: fields.projectId,
      itemId: item.itemId,
      fieldId: fields.statusFieldId,
      optionId,
    });
  }

  /** Set (or with null, clear) the `Agent` field — the delegate in GitHub's
   *  honest words (D5: an app cannot be an assignee, proven 403). */
  async setAgent(id: string, boardNumber: number, delegate: string | null): Promise<void> {
    const fields = await this.boardFields(boardNumber);
    const issue = await this.issue(id);
    const item = itemOn(issue, boardNumber);
    if (!item)
      throw new Error(`${id} is not on board ${boardNumber}; it has no Agent value to ${delegate ? 'set' : 'clear'}`);
    if (!delegate) {
      if (!this.agentOn(issue, boardNumber)) return; // nothing standing to clear
      await this.app.octokit.graphql(CLEAR_SELECT, {
        projectId: fields.projectId,
        itemId: item.itemId,
        fieldId: fields.agentFieldId,
      });
      return;
    }
    const optionId = optionNamed(fields.agentOptions, delegate);
    if (!optionId)
      throw new Error(
        `board ${boardNumber} of ${this.org} has no Agent option "${delegate}": run the project setup to create it`,
      );
    if (this.agentOn(issue, boardNumber) === delegate) return; // already speaks
    await this.app.octokit.graphql(SET_SELECT, {
      projectId: fields.projectId,
      itemId: item.itemId,
      fieldId: fields.agentFieldId,
      optionId,
    });
  }

  /** Open an issue in a repository — the desk's escape hatch. Labels are
   *  added by name (GitHub's own add is not create-on-demand, so each name
   *  is ensured first). Landing on the board in a lane is `setLane`'s. */
  async createIssue(repo: string, input: { title: string; body?: string; labels?: string[] }): Promise<GithubIssue> {
    const [owner, name] = repo.split('/');
    const made = await this.app.octokit.rest.issues.create({
      owner: owner!,
      repo: name!,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    const id = repoIssueId(owner!, name!, made.data.number);
    for (const label of input.labels ?? []) {
      await this.ensureLabel(repo, label);
      await this.app.octokit.rest.issues.addLabels({
        owner: owner!,
        repo: name!,
        issue_number: made.data.number,
        labels: [label],
      });
    }
    return this.issue(id);
  }

  /** Rewrite the issue's own words; only what is named is touched. */
  async updateIssue(id: string, changes: { title?: string; description?: string }): Promise<GithubIssue> {
    const { owner, name, number } = issueRef(id);
    await this.app.octokit.rest.issues.update({
      owner,
      repo: name,
      issue_number: number,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.description !== undefined ? { body: changes.description } : {}),
    });
    return this.issue(id);
  }

  /** The comment trail, oldest first, with the author in GitHub's words —
   *  `authorIsBot` is how aivi's own posts are filtered inbound. */
  async comments(id: string, cap = 300): Promise<GithubComment[]> {
    const { owner, name, number } = issueRef(id);
    const out: GithubComment[] = [];
    for (let page = 1; out.length < cap; page += 1) {
      const { data } = await this.app.octokit.rest.issues.listComments({
        owner,
        repo: name,
        issue_number: number,
        per_page: 100,
        page,
        sort: 'created',
        direction: 'asc',
      });
      out.push(
        ...data.map(c => ({
          id: c.id,
          author: c.user?.login ?? null,
          authorIsBot: c.user?.type === 'Bot',
          body: c.body ?? '',
          at: c.created_at ?? c.updated_at ?? '',
        })),
      );
      if (data.length < 100) break;
    }
    return out;
  }

  /** Post a comment and answer with GitHub's own id — `startSession` hands
   *  that back as the run's conversation handle (D6). */
  async createComment(id: string, body: string): Promise<{ id: number; url: string }> {
    const { owner, name, number } = issueRef(id);
    const made = await this.app.octokit.rest.issues.createComment({ owner, repo: name, issue_number: number, body });
    return { id: made.data.id, url: made.data.html_url };
  }

  async updateComment(id: string, commentId: number, body: string): Promise<void> {
    const { owner, name } = issueRef(id);
    await this.app.octokit.rest.issues.updateComment({ owner, repo: name, comment_id: commentId, body });
  }

  /** One comment's body by id — the status comment's own read, the only
   *  surface a progress edit may build on (never a remembered body). */
  async getComment(id: string, commentId: number): Promise<string | undefined> {
    const { owner, name } = issueRef(id);
    try {
      const { data } = await this.app.octokit.rest.issues.getComment({ owner, repo: name, comment_id: commentId });
      return data.body ?? '';
    } catch (error) {
      if (isGoneError(error)) return undefined;
      throw error;
    }
  }

  async deleteComment(id: string, commentId: number): Promise<void> {
    const { owner, name } = issueRef(id);
    await this.app.octokit.rest.issues.deleteComment({ owner, repo: name, comment_id: commentId });
  }

  /** The `owner/repo#n` behind a GraphQL node id — the `projects_v2_item`
   *  payload names its issue only by node, and the board's events are worth
   *  nothing until that resolves. Non-issue nodes answer undefined. */
  async nodeRef(nodeId: string): Promise<string | undefined> {
    const { node } = await this.app.octokit.graphql<{ node: any }>(NODE_REF, { id: nodeId });
    if (!node?.repository) return undefined;
    return repoIssueId(node.repository.owner.login, node.repository.name, node.databaseId);
  }

  /** The repository's label catalogue — every name it knows. */
  async repoLabels(repo: string, cap = 500): Promise<string[]> {
    const [owner, name] = repo.split('/');
    const out: string[] = [];
    for (let page = 1; out.length < cap; page += 1) {
      const { data } = await this.app.octokit.rest.issues.listLabelsForRepo({
        owner: owner!,
        repo: name!,
        per_page: 100,
        page,
      });
      out.push(...data.map(l => l.name));
      if (data.length < 100) break;
    }
    return out;
  }

  /** Put one label on the ticket, creating it in the repository when none
   *  carries the name (add only, as the tool promises). */
  async addLabel(id: string, label: string): Promise<void> {
    const { owner, name, number } = issueRef(id);
    await this.ensureLabel(id.slice(0, id.indexOf('#')), label);
    await this.app.octokit.rest.issues.addLabels({ owner, repo: name, issue_number: number, labels: [label] });
  }

  async removeLabel(id: string, label: string): Promise<void> {
    const { owner, name, number } = issueRef(id);
    try {
      await this.app.octokit.rest.issues.removeLabel({ owner, repo: name, issue_number: number, name: label });
    } catch (error) {
      if ((error as { status?: number }).status === 404) return; // not on the ticket: already off, said as done
      throw error;
    }
  }

  /** Create a label in the repository when none carries the name. The human
   *  label does not exist on a GitHub repository until aivi makes it —
   *  unlike Linear, where it must pre-exist. */
  async ensureLabel(repo: string, name: string): Promise<void> {
    const [owner, repoName] = repo.split('/');
    try {
      await this.app.octokit.rest.issues.getLabel({ owner: owner!, repo: repoName!, name });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      await this.app.octokit.rest.issues.createLabel({ owner: owner!, repo: repoName!, name, color: 'ededed' });
    }
  }

  /** The assistant's marks (D10): reactions on the issue itself — `eyes`
   *  while the assistant works, `rocket` when it answers. An assistive
   *  surface only: no run state rides a reaction. */
  async addReaction(id: string, content: 'eyes' | 'rocket'): Promise<void> {
    const { owner, name, number } = issueRef(id);
    await this.app.octokit.rest.reactions.createForIssue({ owner, repo: name, issue_number: number, content });
  }

  /** Take the assistant's own `eyes` off (a person's reactions are nobody to
   *  touch: only reactions by aivi's bot are removed). */
  async removeOwnReaction(id: string, content: 'eyes' | 'rocket'): Promise<void> {
    const { owner, name, number } = issueRef(id);
    for (let page = 1; page <= 3; page += 1) {
      const { data } = await this.app.octokit.rest.reactions.listForIssue({
        owner,
        repo: name,
        issue_number: number,
        content,
        per_page: 100,
        page,
      });
      for (const reaction of data)
        if (reaction.user?.login === this.botLogin)
          await this.app.octokit.rest.reactions.deleteForIssue({
            owner,
            repo: name,
            issue_number: number,
            reaction_id: reaction.id,
          });
      if (data.length < 100) break;
    }
  }
}

/** The tracker's client over the home's one app: connect through
 *  `@aivi/github`, and the webhook secret is read where it lives. A missing
 *  secret is a ConfigurationError the operator fixes in `<home>/.env` — no
 *  delivery is verifiable without it, so the module refuses to start. */
export async function githubClient(log?: Logger): Promise<{ client: GithubClient; webhookSecret: string }> {
  const app = await githubApp({ ...(log ? { log } : {}) });
  const webhookSecret = process.env[GITHUB_WEBHOOK_SECRET_ENV];
  if (!webhookSecret)
    throw new ConfigurationError(
      `tracker-github: ${GITHUB_WEBHOOK_SECRET_ENV} is not set. Put the webhook secret you pasted on the app's settings page in <home>/.env; without it every delivery is unverifiable.`,
    );
  return { client: new GithubClient(app), webhookSecret };
}
