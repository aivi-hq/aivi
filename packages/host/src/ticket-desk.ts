/**
 * The ticket desk: the `aivi_ticket_*` tools, claimed by the **host** once for
 * the whole home. A tracker's `desk` (the `TicketDesk` at `@aivi/plugin/tracker`)
 * answers for its own platform; this file owns the tools themselves — the ids,
 * the argument checks, and the ground truth of the call: it must come from a
 * live run, and it reaches only that run's ticket, never one the model names.
 *
 * **Permission is OpenCode's, not ours.** The seeded config denies every one
 * of these actions to every agent; an agent file that needs the desk allows
 * the tools it speaks (product does, in its frontmatter). A denied tool is
 * invisible to the model — the gate that works is the one the platform
 * enforces. What the host checks is who is calling: the ledger names the run,
 * the run names the tracker, and the tracker's desk does the platform's work.
 * Because the host holds the claim, several trackers can serve one home, each
 * with its workers' desk; the ids are `TICKET_TOOL_ACTIONS` and the installer's
 * `aivi_ticket_*` wildcard covers them all.
 */
import type { Logger, ToolDescriptor } from '@aivi/core';
import { ToolError, type ToolHandler } from '@aivi/plugin';
import { isTerminal, type RunView } from '@aivi/plugin/run';
import type { TicketDesk, Tracker } from '@aivi/plugin/tracker';

/** One desk tool: what `GET /tools` serves and `POST /tools` dispatches. */
export interface DeskTool {
  descriptor: ToolDescriptor;
  handler: ToolHandler;
}

/** What the desk asks of the orchestrator, narrowed to the desk's need: find
 *  the run a session belongs to, find that run's tracker, and wake the walk
 *  after a new ticket is born. */
export interface TicketDeskDeps {
  runBySession(sessionId: string): RunView | undefined;
  tracker(trackerId: string): Tracker | undefined;
  wake(projectId: string): Promise<void>;
}

const str = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(400, `${field} must be a non-empty string.`);
  if (value.length > max) throw new ToolError(400, `${field} is longer than ${max} characters.`);
  return value;
};

export function createTicketDesk(deps: TicketDeskDeps, log: Logger): DeskTool[] {
  /** Whose ticket this is: the run the calling session belongs to, and the
   *  desk of the tracker that works it. Never the model's word — the ledger's. */
  const desk =
    (tool: string) =>
    (call: { sessionId: string }): { run: RunView; desk: TicketDesk } => {
      const run = deps.runBySession(call.sessionId);
      if (!run) throw new ToolError(404, `This session is not an aivi run; aivi_ticket_${tool} is not available here.`);
      if (isTerminal(run.state))
        throw new ToolError(409, `This run has ended; aivi_ticket_${tool} works the ticket only while the run lives.`);
      const tracker = deps.tracker(run.trackerId);
      if (!tracker)
        throw new ToolError(
          409,
          `The tracker "${run.trackerId}" of this run is not registered; its desk is unreachable.`,
        );
      return { run, desk: tracker.desk };
    };

  const tools: DeskTool[] = [];
  const add = (
    name: string,
    description: string,
    input: Record<string, unknown>,
    work: (run: RunView, desk: TicketDesk, input: Record<string, unknown>) => Promise<unknown>,
  ): void => {
    tools.push({
      descriptor: { namespace: 'aivi', name, description, input },
      handler: async call => {
        const { run, desk: tickets } = desk(name.replace(/^ticket_/, ''))(call);
        const answer = await work(run, tickets, call.input);
        log.debug('ticket.tool', { tool: name, run: run.id, tracker: run.trackerId });
        return answer;
      },
    });
  };

  const noInput = { type: 'object', properties: {}, additionalProperties: false } as const;

  add(
    'ticket_read',
    'Read the ticket this run works: identifier, title, description, lane, labels, url.',
    noInput,
    async (r, desk) => desk.read(r),
  );

  add(
    'ticket_comments',
    'Read this ticket’s comment trail, oldest first: author, text, time.',
    noInput,
    async (r, desk) => ({
      comments: await desk.comments(r),
    }),
  );

  add(
    'ticket_labels',
    'The team’s label catalogue and the labels standing on this ticket now.',
    noInput,
    async (r, desk) => desk.labels(r),
  );

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
    async (r, desk, input) => {
      const changes: { title?: string; description?: string } = {};
      if (input.title !== undefined) changes.title = str(input.title, 'title', 250);
      if (input.description !== undefined) changes.description = str(input.description, 'description', 65_536);
      if (!changes.title && changes.description === undefined)
        throw new ToolError(400, 'Give a title, a description, or both — ticket_edit touches nothing else.');
      return desk.edit(r, changes);
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
    async (r, desk, input) => {
      await desk.comment(r, str(input.text, 'text', 65_536));
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
    async (r, desk, input) => {
      const issue = await desk.create(r, {
        title: str(input.title, 'title', 250),
        description: str(input.description, 'description', 65_536),
      });
      // The platform's webhook for this very issue is the normal wake; asking
      // again is free and idempotent, and the escape hatch must not wait on a
      // webhook. A hiccup here never fails a create that already landed.
      await deps.wake(r.projectId).catch(error => log.warn('ticket.create.wake.failed', { run: r.id, error }));
      return issue;
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
      async (r, desk, input) => {
        const label = str(input.label, 'label', 100);
        await desk.label(r, label, on);
        return { label, on };
      },
    );

  return tools;
}
