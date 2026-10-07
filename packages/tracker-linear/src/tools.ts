/**
 * The ticket desk: the `aivi_ticket_*` tools — a worker's hand on the ticket
 * itself, no agent session in between. The base kit is deliberately generic
 * (read, write the words, comment, label, open a new ticket); an agent that
 * needs more of Linear upgrades to the Linear MCP in its own agent file,
 * which is the ruled replacement path.
 *
 * **Permission is OpenCode's, not ours.** The seeded config denies every one
 * of these actions to every agent; an agent file that needs the desk allows
 * the tools it speaks (product does, in its frontmatter). A denied tool is
 * invisible to the model — the host never re-checks an agent name, because
 * the gate that works is the one the platform enforces. What the host *does*
 * check is the ground truth of the call: it must come from a live run this
 * tracker works, so the ticket is known without the model naming it — and a
 * worker can never point the tools at a ticket its run does not work.
 */
import type { ToolDescriptor } from '@aivi/core';
import { type AiviServices, ToolError, type ToolHandler } from '@aivi/plugin';
import { isTerminal, type RunView } from '@aivi/plugin/run';
import type { Platform } from '@aivi/plugin/tracker';
import type { LinearConfig } from './config.ts';
import { MODULE_ID, primaryLinearApp } from './config.ts';
import { projectLinear } from './projects.ts';

export interface TicketTool {
  descriptor: ToolDescriptor;
  handler: ToolHandler;
}

const str = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(400, `${field} must be a non-empty string.`);
  if (value.length > max) throw new ToolError(400, `${field} is longer than ${max} characters.`);
  return value;
};

export function createTicketTools(services: AiviServices, config: LinearConfig, tracker: Platform): TicketTool[] {
  const app = primaryLinearApp(config);
  if (!app) throw new ToolError(409, 'the tracker has no primary Linear app; the ticket desk is not available.');
  const log = services.log.getChild('tickets');

  /** Whose ticket this is: the run the calling session belongs to. Never
   *  the model's word — the ledger's. */
  const desk =
    (tool: string) =>
    (call: { sessionId: string }): RunView => {
      const run = services.orchestrator.runBySession(call.sessionId);
      if (!run) throw new ToolError(404, `This session is not an aivi run; aivi_ticket_${tool} is not available here.`);
      if (run.trackerId !== MODULE_ID)
        throw new ToolError(409, `This run is not worked on Linear; aivi_ticket_${tool} does not reach its ticket.`);
      if (isTerminal(run.state))
        throw new ToolError(409, `This run has ended; aivi_ticket_${tool} works the ticket only while the run lives.`);
      return run;
    };

  /** Where a new ticket is born: the project's teams, the create lane as it
   *  takes effect (project's `createLane`, defaults', else the project's
   *  first configured lane). An explicit create lane must exist in a team —
   *  a wrong name is said, never guessed past; the fallback lane lands where
   *  Linear's own default sends new issues when no team carries its name. */
  const createTarget = async (projectId: string): Promise<{ teamId: string; lane?: string }> => {
    const linear = projectLinear(services.loaded, projectId);
    if (!linear?.teams.length)
      throw new ToolError(409, 'this project has no Linear teams; aivi_ticket_create has nowhere to create.');
    const explicit = linear.createLane;
    const lane = explicit ?? services.loaded.projects.find(p => p.id === projectId)?.lanes?.[0]?.name;
    if (lane)
      for (const teamId of linear.teams) {
        const states = await tracker.laneStates(app, teamId);
        if (states.some(s => s.name === lane)) return { teamId, lane };
      }
    if (explicit)
      throw new ToolError(
        409,
        `createLane "${explicit}" names no state in this project's Linear teams — fix createLane in config.`,
      );
    return { teamId: linear.teams[0]! };
  };

  const tools: TicketTool[] = [];
  const add = (
    name: string,
    description: string,
    input: Record<string, unknown>,
    run: (r: RunView, input: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    tools.push({
      descriptor: { namespace: 'aivi', name, description, input },
      handler: async call => {
        const view = desk(name.replace(/^ticket_/, ''))(call);
        const answer = await run(view, call.input);
        log.debug('ticket.tool', { tool: name, run: view.id });
        return answer;
      },
    });
  };

  const noInput = { type: 'object', properties: {}, additionalProperties: false } as const;

  add(
    'ticket_read',
    'Read the ticket this run works: identifier, title, description, lane, labels, url.',
    noInput,
    async r => {
      const issue = await tracker.issue(app, r.ticketId);
      return {
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        lane: issue.state.name,
        labels: issue.labels.map(l => l.name),
        url: issue.url,
      };
    },
  );

  add('ticket_comments', 'Read this ticket’s comment trail, oldest first: author, text, time.', noInput, async r => ({
    comments: await tracker.ticketComments!(app, r.ticketId),
  }));

  add('ticket_labels', 'The team’s label catalogue and the labels standing on this ticket now.', noInput, async r => {
    const issue = await tracker.issue(app, r.ticketId);
    return { team: await tracker.teamLabels!(app, issue.teamId), on: issue.labels.map(l => l.name) };
  });

  add(
    'ticket_edit',
    'Rewrite this ticket’s own words: title and/or description, at least one. Only what you name is touched. This run’s ticket — no other.',
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The new title.' },
        description: { type: 'string', description: 'The new description, in full.' },
      },
      additionalProperties: false,
    },
    async (r, input) => {
      const changes: { title?: string; description?: string } = {};
      if (input.title !== undefined) changes.title = str(input.title, 'title', 250);
      if (input.description !== undefined) changes.description = str(input.description, 'description', 65_536);
      if (!changes.title && changes.description === undefined)
        throw new ToolError(400, 'Give a title, a description, or both — ticket_edit touches nothing else.');
      const issue = await tracker.editIssue!(app, r.ticketId, changes);
      return { identifier: issue.identifier, title: issue.title, url: issue.url };
    },
  );

  add(
    'ticket_comment',
    'Leave a plain comment on this ticket — aivi’s own note for people reading the ticket, not the agent session.',
    {
      type: 'object',
      properties: { text: { type: 'string', description: 'The comment, in words a person reads.' } },
      required: ['text'],
      additionalProperties: false,
    },
    async (r, input) => {
      await tracker.addComment!(app, r.ticketId, str(input.text, 'text', 65_536));
      return { posted: true };
    },
  );

  add(
    'ticket_create',
    'Open a new ticket — the escape hatch for work this ticket should not carry. Title and description; it lands in the project’s create lane and the walk picks it up on its own. Returns the new ticket’s identifier and url: quote them wherever you write.',
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The ticket a person would open.' },
        description: { type: 'string', description: 'What it is, why it exists, what “done” means.' },
      },
      required: ['title', 'description'],
      additionalProperties: false,
    },
    async (r, input) => {
      const target = await createTarget(r.projectId);
      const issue = await tracker.createIssue!(app, {
        teamId: target.teamId,
        title: str(input.title, 'title', 250),
        description: str(input.description, 'description', 65_536),
        ...(target.lane ? { lane: target.lane } : {}),
      });
      // The webhook for this very issue is the normal wake; asking again is
      // free and idempotent, and the escape hatch must not wait on a webhook.
      await services.orchestrator.wake(r.projectId).catch(() => {});
      return { identifier: issue.identifier, url: issue.url, lane: issue.state.name };
    },
  );

  for (const [name, on, verb] of [
    ['ticket_add_label', true, 'Add'],
    ['ticket_remove_label', false, 'Take off'],
  ] as const)
    add(
      name,
      `${verb} one label ${on ? 'to' : 'off'} this ticket. A name the team does not have yet is created first (add only).`,
      {
        type: 'object',
        properties: { label: { type: 'string', description: 'The label name, exactly as the team spells it.' } },
        required: ['label'],
        additionalProperties: false,
      },
      async (r, input) => {
        const label = str(input.label, 'label', 100);
        await tracker.apply!(app, r.ticketId, { kind: 'label', label, on });
        return { label, on };
      },
    );

  return tools;
}
