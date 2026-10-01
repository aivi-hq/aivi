import type { Logger } from '@aivi/core';
import type { TicketFeed } from '@aivi/host';
import type { AiviServices } from '@aivi/plugin';
import type { LinearClient, LinearTeam } from './client.ts';
import type { LinearConfig } from './config.ts';
import { primaryLinearApp } from './config.ts';
import { projectLinear } from './projects.ts';
import { StoppedTickets } from './stopped.ts';
import { clientFor, isClosed } from './tracker.ts';

/** The worker's first words about a ticket: who it is, what it says. The
 *  dossier is the same for a delegation and a walk pickup — the ticket's
 *  text does not depend on how the worker was reached. */
export const issueDossier = (issue: { identifier: string; title: string; description: string | null }) =>
  `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`;

/**
 * The Linear board as the orchestrator's eligibility walk reads it
 * (docs/orchestrator.md, "How work gets picked"): which projects this
 * installation speaks for, what sits in a lane top-to-bottom, and how a
 * ticket enters a lane.
 *
 * The `Tracker` adapter is conversation-keyed because a webhook arrives
 * through an agent session; the walk has no session and no conversation,
 * so this reads with the installation's own credentials — the primary
 * app, the one that carries workspace data. Reads are one client and one
 * team-and-state board, both fetched once per module start: the states a
 * walk matches lanes against change when a person changes them, and a
 * restart is when aivi learns of that.
 *
 * What comes back **is** eligible work: archived tickets and tickets
 * carrying the human-work label are left out here, because those are
 * Linear's words for "a person owns this" and the orchestrator never
 * learns Linear's words.
 */
export function linearFeed(config: LinearConfig, services: AiviServices, log: Logger): TicketFeed {
  let reader: LinearClient | undefined;
  const read = (): LinearClient => (reader ??= clientFor(config, primaryLinearApp(config), log));
  const stopped = new StoppedTickets(services.store);
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
          if (stopped.has(issue.id)) continue; // a person stopped its worker: stop means stop
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
      await read().transitionIssue(ticketId, lane.id);
    },
    firstMessage: async (projectId, ticketId, lane) => {
      const project = services.loaded.projects.find(p => p.id === projectId);
      if (!project) throw new Error(`no project ${projectId} in the loaded config`);
      const issue = await read().issue(ticketId);
      if (issue.archivedAt) return undefined; // deleted between listing and start: not work, walk on
      return [
        `[aivi picked ${issue.identifier} "${issue.title}" for you (project ${projectId}, lane "${lane.name}"). You work in the project's checkout ${project.directory}; the agent file says what you may change.]`,
        issueDossier(issue),
      ].join('\n\n');
    },
  };
}
