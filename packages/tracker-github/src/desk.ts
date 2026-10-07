/**
 * The GitHub tracker's answer to the ticket desk (the `TicketDesk` contract
 * at `@aivi/plugin/tracker`). The host owns the `aivi_ticket_*` tools and the
 * ground truth of the call — this file answers what each one *is* on GitHub:
 * which ticket a plain comment lands on, which repository a new ticket is
 * born in, what the repository's label catalogue means. GitHub has one app
 * and no sessions to speak through, so every call arrives on the app's own
 * feed: `GITHUB_FEED` is the desk's whole conversation.
 */
import type { LoadedConfig } from '@aivi/core';
import { ToolError } from '@aivi/plugin';
import type { RunView } from '@aivi/plugin/run';
import type { Platform, TicketDesk } from '@aivi/plugin/tracker';
import type { GithubConfig } from './config.ts';
import { projectGithub } from './projects.ts';
import { GITHUB_FEED } from './tracker.ts';

export function createGithubDesk(loaded: LoadedConfig, _config: GithubConfig, platform: Platform): TicketDesk {
  const ticket = (run: RunView) => platform.issue(GITHUB_FEED, run.ticketId);

  /** Where a new ticket is born: the project's repositories, the create lane
   *  as it takes effect (project's `createLane`, defaults', else the
   *  project's first configured lane). An explicit create lane must be a
   *  Status option on the board — a wrong name is said, never guessed past;
   *  the fallback lane lands where GitHub's own default sends new issues
   *  when no board carries its name. */
  const createTarget = async (projectId: string): Promise<{ repo: string; lane?: string }> => {
    const github = projectGithub(loaded, projectId);
    if (!github?.repos.length)
      throw new ToolError(409, 'this project has no GitHub repositories; aivi_ticket_create has nowhere to create.');
    const explicit = github.createLane;
    const lane = explicit ?? loaded.projects.find(p => p.id === projectId)?.lanes?.[0]?.name;
    if (lane) {
      const states = await platform.laneStates(GITHUB_FEED, github.repos[0]!);
      if (states.some(s => s.name === lane)) return { repo: github.repos[0]!, lane };
    }
    if (explicit)
      throw new ToolError(
        409,
        `createLane "${explicit}" names no Status option on this project's board — fix createLane in config.`,
      );
    return { repo: github.repos[0]! };
  };

  return {
    async read(run) {
      const issue = await ticket(run);
      return {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        lane: issue.state.name,
        labels: issue.labels.map(l => l.name),
        url: issue.url,
      };
    },
    comments(run) {
      return platform.ticketComments(GITHUB_FEED, run.ticketId);
    },
    async labels(run) {
      const issue = await ticket(run);
      return { team: await platform.teamLabels(GITHUB_FEED, issue.teamId), on: issue.labels.map(l => l.name) };
    },
    async edit(run, changes) {
      const issue = await platform.editIssue(GITHUB_FEED, run.ticketId, changes);
      return { identifier: issue.identifier, title: issue.title, url: issue.url };
    },
    comment(run, text) {
      return platform.addComment(GITHUB_FEED, run.ticketId, text);
    },
    async create(run, input) {
      const target = await createTarget(run.projectId);
      const issue = await platform.createIssue(GITHUB_FEED, {
        teamId: target.repo,
        title: input.title,
        description: input.description,
        ...(target.lane ? { lane: target.lane } : {}),
      });
      return { identifier: issue.identifier, url: issue.url, lane: issue.state.name };
    },
    async label(run, label, on) {
      await platform.apply(GITHUB_FEED, run.ticketId, { kind: 'label', label, on });
    },
  };
}
