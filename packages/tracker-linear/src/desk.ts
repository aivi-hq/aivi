/**
 * Linear's answer to the ticket desk (the `TicketDesk` contract at
 * `@aivi/plugin/tracker`). The host owns the `aivi_ticket_*` tools and the
 * ground truth of the call — this file answers what each one *is* on Linear:
 * which app's feed a plain comment lands on, which team a new ticket is born
 * in, what the team's label catalogue means. The desk speaks through the
 * **primary** app: it holds the credentials, and a comment posted there is
 * the app's own.
 */
import type { LoadedConfig } from '@aivi/core';
import { ToolError } from '@aivi/plugin';
import type { RunView } from '@aivi/plugin/run';
import type { Platform, TicketDesk } from '@aivi/plugin/tracker';
import type { LinearConfig } from './config.ts';
import { primaryLinearApp } from './config.ts';
import { projectLinear } from './projects.ts';

export function createLinearDesk(loaded: LoadedConfig, config: LinearConfig, platform: Platform): TicketDesk {
  const app = primaryLinearApp(config);
  if (!app) throw new ToolError(409, 'the tracker has no primary Linear app; the ticket desk is not available.');

  const ticket = (run: RunView) => platform.issue(app, run.ticketId);

  /** Where a new ticket is born: the project's teams, the create lane as it
   *  takes effect (project's `createLane`, defaults', else the project's
   *  first configured lane). An explicit create lane must exist in a team —
   *  a wrong name is said, never guessed past; the fallback lane lands where
   *  Linear's own default sends new issues when no team carries its name. */
  const createTarget = async (projectId: string): Promise<{ teamId: string; lane?: string }> => {
    const linear = projectLinear(loaded, projectId);
    if (!linear?.teams.length)
      throw new ToolError(409, 'this project has no Linear teams; aivi_ticket_create has nowhere to create.');
    const explicit = linear.createLane;
    const lane = explicit ?? loaded.projects.find(p => p.id === projectId)?.lanes?.[0]?.name;
    if (lane)
      for (const teamId of linear.teams) {
        const states = await platform.laneStates(app, teamId);
        if (states.some(s => s.name === lane)) return { teamId, lane };
      }
    if (explicit)
      throw new ToolError(
        409,
        `createLane "${explicit}" names no state in this project's Linear teams — fix createLane in config.`,
      );
    return { teamId: linear.teams[0]! };
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
      return platform.ticketComments(app, run.ticketId);
    },
    async labels(run) {
      const issue = await ticket(run);
      return { team: await platform.teamLabels(app, issue.teamId), on: issue.labels.map(l => l.name) };
    },
    async edit(run, changes) {
      const issue = await platform.editIssue(app, run.ticketId, changes);
      return { identifier: issue.identifier, title: issue.title, url: issue.url };
    },
    comment(run, text) {
      return platform.addComment(app, run.ticketId, text);
    },
    async create(run, input) {
      const target = await createTarget(run.projectId);
      const issue = await platform.createIssue(app, {
        teamId: target.teamId,
        title: input.title,
        description: input.description,
        ...(target.lane ? { lane: target.lane } : {}),
      });
      return { identifier: issue.identifier, url: issue.url, lane: issue.state.name };
    },
    async label(run, label, on) {
      await platform.apply(app, run.ticketId, { kind: 'label', label, on });
    },
  };
}
