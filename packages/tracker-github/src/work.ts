import type { Logger } from '@aivi/core';
import type { AiviServices } from '@aivi/plugin';
import type { GithubClient } from './client.ts';
import type { GithubConfig } from './config.ts';
import { projectForIssue, projectGithub } from './projects.ts';

/** The ticket's own words: what it is, what it says. This is the **summary**
 *  `initWork` hands the orchestrator, and the orchestrator composes the
 *  worker's first prompt around it — the same dossier for a queue pickup
 *  and a plain walk claim: the ticket's text does not depend on how the
 *  worker was reached. */
export const issueDossier = (issue: { identifier: string; title: string; description: string | null }) =>
  `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`;

/** What the walk reads and what `initWork` opens through: the GitHub board,
 *  in the installation's own credentials. */
export interface GithubBoard {
  projects(): string[];
  tickets(projectId: string, lane: string): Promise<{ id: string; blocked: boolean }[]>;
  moveTo(projectId: string, ticketId: string, lane: string): Promise<void>;
  /** The ticket fresh from the board, or undefined when a person deleted it. */
  issue(ticketId: string): Promise<GithubIssueWords | undefined>;
}

/** The fields of a listed issue the tracker's stages speak with. */
export interface GithubIssueWords {
  identifier: string;
  title: string;
  description: string | null;
  /** The repository — GitHub's team. */
  teamId: string;
  /** The ticket's Status on the board its repository feeds; '' when the
   *  repository feeds no project. */
  stateName: string;
  /** GitHub names no branch; the tracker generates one (D8). */
  branchName: string;
}

/**
 * The GitHub board as the orchestrator's eligibility walk reads it
 * (docs/orchestrator.md, "How work gets picked"): which projects this
 * installation speaks for, what sits in a lane, and how a ticket enters one.
 *
 * A GitHub repository **is** the team: a project maps its repositories to one
 * projectsV2 board (D1 — one tracker per project, and the walk visits the
 * project's lanes as the board's Status options). The walk's order is each
 * repository's open issues, newest created first — GitHub's own list order;
 * the board's per-view ordering is a person's reading and no eligibility
 * depends on it.
 *
 * What comes back **is** eligible work: closed tickets are out of the listing
 * entirely, and out here go the tickets carrying the human-work label and the
 * tickets with any `Agent` value — someone already speaks for them, aivi
 * included (a hand-set `Agent` gets the fixed refusal in the module, and the
 * walk starts nothing twice). A stop is not remembered here (ruled
 * 2026-10-02): a stopped ticket goes back to the board, and "not that one
 * again" is the human label's job, not a memory in somebody's database.
 */
export function githubBoard(
  config: GithubConfig,
  services: Pick<AiviServices, 'loaded'>,
  client: GithubClient,
  log: Logger,
): GithubBoard {
  /** A ticket the walk may start: not a person's to work, and nobody already
   *  speaks for it — not eligible, and never knocked twice. */
  const walkable = (issue: { completed: boolean; labels: { name: string }[]; agent: string | undefined }): boolean =>
    !issue.completed && !issue.labels.some(l => l.name === config.humanLabel) && !issue.agent;
  return {
    projects: () =>
      services.loaded.projects.filter(p => !p.removed && projectGithub(services.loaded, p.id)).map(p => p.id),
    tickets: async (projectId, lane) => {
      const github = projectGithub(services.loaded, projectId);
      if (!github) return [];
      const out: { id: string; blocked: boolean }[] = [];
      for (const repo of github.repos) {
        const read = await client.openIssues(repo);
        if (read.truncated) log.warn('walk.board.truncated', { project: projectId, lane, repo });
        for (const issue of read.issues) {
          const standing = client.laneOf(issue, github.board);
          if (!standing || standing.name !== lane) continue; // not on this board, not in this lane
          if (
            !walkable({
              completed: issue.state === 'closed',
              labels: issue.labels,
              agent: client.agentOn(issue, github.board),
            })
          )
            continue;
          out.push({ id: issue.ref, blocked: issue.blockedBy.some(b => !b.completed) });
        }
      }
      return out;
    },
    moveTo: async (projectId, ticketId, lane) => {
      const github = projectGithub(services.loaded, projectId);
      if (!github) throw new Error(`project ${projectId} has no GitHub board: ${ticketId} cannot enter lane "${lane}"`);
      // Idempotence is the board's promise: the orchestrator re-drives an
      // owed move after a retry and from the next boot, and a move that
      // already landed lands here as nothing — no second word to GitHub.
      // (The client holds that check: onto the board first, then the option,
      // and an option it lacks is said by name, never created.)
      await client.setLane(ticketId, github.board, lane);
    },
    issue: async ticketId => {
      const issue = await client.issue(ticketId);
      const github = projectForIssue(services.loaded, { repo: issue.repo })?.github;
      const lane = github ? client.laneOf(issue, github.board) : undefined;
      return {
        identifier: issue.ref,
        title: issue.title,
        description: issue.body,
        teamId: issue.repo,
        stateName: lane?.name ?? '',
        branchName: '',
      };
    },
  };
}
