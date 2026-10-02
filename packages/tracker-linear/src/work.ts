import type { Logger } from '@aivi/core';
import type { AiviServices } from '@aivi/plugin';
import type { LinearClient, LinearTeam } from './client.ts';
import type { LinearConfig } from './config.ts';
import { primaryLinearApp } from './config.ts';
import { projectLinear } from './projects.ts';
import { clientFor, isClosed } from './tracker.ts';

/** The ticket's own words: what it is, what it says. This is the **summary**
 *  `initWork` hands the orchestrator, and the orchestrator composes the
 *  worker's first prompt around it — the same dossier for a queue pickup
 *  and a plain walk claim: the ticket's text does not depend on how the
 *  worker was reached. */
export const issueDossier = (issue: { identifier: string; title: string; description: string | null }) =>
  `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`;

/** What the walk reads and what `initWork` opens through: the Linear board,
 *  in the installation's own credentials. */
export interface LinearBoard {
  projects(): string[];
  tickets(projectId: string, lane: string): Promise<{ id: string; blocked: boolean }[]>;
  moveTo(projectId: string, ticketId: string, lane: string): Promise<void>;
  /** The ticket fresh from the board, or null when a person deleted it. */
  issue(ticketId: string): Promise<LinearIssueWords | undefined>;
}

/** The fields of a listed issue the tracker's stages speak with. */
export interface LinearIssueWords {
  identifier: string;
  title: string;
  description: string | null;
  teamId: string;
  stateName: string;
}

/**
 * The Linear board as the orchestrator's eligibility walk reads it
 * (docs/orchestrator.md, "How work gets picked"): which projects this
 * installation speaks for, what sits in a lane top-to-bottom, and how a
 * ticket enters a lane.
 *
 * The adapter is conversation-keyed because a webhook arrives through an
 * agent session; the walk has no session and no conversation, so this reads
 * with the installation's own credentials — the primary app, the one that
 * carries workspace data. Reads are one client and one team-and-state
 * board, both fetched once per module start: the states a walk matches
 * lanes against change when a person changes them, and a restart is when
 * aivi learns of that.
 *
 * What comes back **is** eligible work: archived tickets, tickets carrying
 * the human-work label, and tickets that already have a delegate are left
 * out here, because those are Linear's words for "a person owns this" and
 * the orchestrator never learns Linear's words. A delegate rules the ticket
 * out (ruled 2026-10-02): someone already speaks for it, and re-delegating
 * to the user it already has is a mutation no-op — Linear makes no session
 * for it, which was seven silent failures; now the walk simply leaves the
 * ticket alone until a person clears the delegate. A stop is not remembered
 * here (ruled 2026-10-02): a stopped ticket goes back to the board, and
 * "not that one again" is the HITL label's job, not a memory in somebody's
 * database.
 *
 * `openClient` is the loader seam the knowledge service also uses: tests
 * read a fake board with no credentials; production reads the primary app.
 */
export function linearBoard(
  config: LinearConfig,
  services: Pick<AiviServices, 'loaded'>,
  log: Logger,
  openClient: (app: string) => LinearClient = app => clientFor(config, app, log),
): LinearBoard {
  let reader: LinearClient | undefined;
  const read = (): LinearClient => (reader ??= openClient(primaryLinearApp(config) ?? ''));
  let board: LinearTeam[] | undefined;
  const teams = async (): Promise<LinearTeam[]> => (board ??= await read().listTeams());
  return {
    projects: () =>
      services.loaded.projects.filter(p => !p.removed && projectLinear(services.loaded, p.id)).map(p => p.id),
    tickets: async (projectId, state) => {
      const linear = projectLinear(services.loaded, projectId);
      if (!linear) return [];
      const out: { id: string; blocked: boolean }[] = [];
      for (const teamId of linear.teams) {
        const team = (await teams()).find(t => t.id === teamId);
        const lane = team?.states.find(s => s.name === state);
        if (!team || !lane) continue; // this team's workflow has no such lane: nothing sits there
        const page = await read().issuesIn(team.id, lane.id);
        if (page.truncated) log.warn('walk.board.truncated', { project: projectId, lane: state, team: team.key });
        for (const issue of page.issues) {
          if (issue.archivedAt) continue; // deleted between the listing and this breath
          if (issue.labels.some(l => l.name === config.humanLabel)) continue; // a person's to work
          if (issue.delegate) continue; // someone already speaks for it: not eligible, not knocked twice
          out.push({ id: issue.id, blocked: issue.blockedBy.some(b => !isClosed(b.state.type)) });
        }
      }
      return out;
    },
    moveTo: async (projectId, ticketId, state) => {
      const issue = await read().issue(ticketId);
      const team = (await teams()).find(t => t.id === issue.team.id);
      const lane = team?.states.find(s => s.name === state);
      if (!team || !lane)
        throw new Error(
          `Linear team ${issue.team.key} has no state "${state}": ${ticketId} cannot enter project ${projectId}`,
        );
      // Idempotence is the board's promise: the orchestrator re-drives an
      // owed move after a retry and from the next boot, and a move that
      // already landed lands here as nothing — no second word to Linear.
      if (issue.state.name === state) return;
      await read().transitionIssue(ticketId, lane.id);
    },
    issue: async ticketId => {
      const issue = await read().issue(ticketId);
      if (issue.archivedAt) return undefined; // deleted: not work, and the stage says so
      return {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        teamId: issue.team.id,
        stateName: issue.state.name,
      };
    },
  };
}
