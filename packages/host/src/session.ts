import type { Logger } from '@aivi/core';
import { errorMessage, silentLogger } from '@aivi/core';
import type { SessionEvents } from './events.ts';
import type { OpenCodeClient } from './opencode.ts';

type NativeMessages = Awaited<ReturnType<OpenCodeClient['session']['context']>>;
type PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' };
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Metadata = Record<string, Json>;

/** Thrown while a turn is still running; callers keep waiting. */
export class PendingAnswer extends Error {}
/**
 * The turn failed before its prompt was accepted (discovery, create, get, rules).
 * Nothing runs on the agent's side, so callers may fail cleanly and release capacity.
 */
export class TurnNotStarted extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}
/** The agent asked for a permission and the policy was `fail`. The session stays inspectable. */
export class PermissionRequired extends Error {
  readonly requests: { action: string; resources: string[] }[];
  constructor(requests: { action: string; resources: string[] }[]) {
    super(`Agent requires approval: ${requests.map(r => `${r.action} ${r.resources.join(', ')}`).join('; ')}`);
    this.requests = requests;
  }
}

/** Resolve the client for one turn; a discovery failure is a turn that never started. */
export async function connectForTurn(opencode: () => Promise<OpenCodeClient>): Promise<OpenCodeClient> {
  try {
    return await opencode();
  } catch (error) {
    throw new TurnNotStarted(error);
  }
}

/** The native ids a run's turn uses, derived from the run id so a lost response has a known target. */
export function turnIdsFor(runId: string): { sessionId: string; messageId: string } {
  const suffix = runId.replaceAll('-', '');
  return { sessionId: `ses_aivi_${suffix}`, messageId: `msg_aivi_${suffix}` };
}

export interface TurnInput {
  /** Client-chosen id (`ses_…`). Persist it before calling so a lost response has a reconciliation target. */
  sessionId: string;
  agent: string;
  directory: string;
  /** Create the session first; false when continuing an existing conversation. */
  create: boolean;
  title?: string;
  /** Stored on the session; aivi conventionally uses `{ aivi: { origin, … } }`. */
  sessionMetadata?: Metadata;
  /** Applied at create time and re-applied before every prompt so a session cannot drift. */
  permissions?: PermissionRule[];
  /** Client-chosen id (`msg_…`); also the key used to find this turn in the context. */
  messageId: string;
  text: string;
  messageMetadata?: Metadata;
  /** Pin the session to this model; absent means the agent file's `model`, resolved per turn. */
  model?: { providerID: string; modelID: string; variant?: string };
}

export interface TurnOptions {
  signal: AbortSignal;
  /**
   * What to do when the agent asks for a permission nobody is there to grant.
   * `reject` (default for unattended work): deny and let the agent continue.
   * `fail`: throw `PermissionRequired`, leaving the prompt pending for a human.
   */
  onPermission?: 'reject' | 'fail';
  /** The host's OpenCode event stream; permission prompts arrive here as `permission.asked`. */
  events: SessionEvents;
  log?: Logger;
  /** Called once the session exists (after create) so callers can persist that fact. */
  onCreated?: () => void;
}

export interface TurnResult {
  sessionId: string;
  text: string;
  /** Permissions that were auto-rejected during this turn, for the audit trail. */
  rejected: { action: string; resources: string[] }[];
}

/**
 * Drive one turn of an OpenCode session to a verified end:
 * create (optional) → check agent/directory → apply permissions → prompt → wait,
 * answering permission prompts per policy → verify the final answer.
 *
 * Verified against OpenCode 2.0.3: a finished turn reads
 * `user → assistant(finish: "stop", time.completed) → idle(outcome: "succeeded")`,
 * and a pending permission parks `session.wait` until someone replies.
 */
export async function runTurn(client: OpenCodeClient, input: TurnInput, options: TurnOptions): Promise<TurnResult> {
  const { signal } = options;
  const log = (options.log ?? silentLogger).child({ session: input.sessionId, turn: input.messageId });
  const onPermission = options.onPermission ?? 'reject';
  const sessionID = input.sessionId;
  const request = { signal };

  const aivi = input.messageMetadata?.aivi;
  const messageMetadata: Metadata = {
    ...input.messageMetadata,
    aivi: { ...(aivi && typeof aivi === 'object' && !Array.isArray(aivi) ? aivi : {}), message: input.messageId },
  };
  try {
    // The API does not substitute the agent file's model the way the TUI does (seen live 2026-09-15:
    // sessions ran OpenCode's default model). The model is a session property; aivi sets it.
    const wanted = input.model
      ? {
          providerID: input.model.providerID,
          id: input.model.modelID,
          ...(input.model.variant ? { variant: input.model.variant } : {}),
        }
      : await agentModel(client, input.agent, input.directory, request);
    if (input.create) {
      await client.session.create(
        {
          id: sessionID,
          agent: input.agent,
          location: { directory: input.directory },
          ...(wanted ? { model: wanted } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.sessionMetadata ? { metadata: input.sessionMetadata } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
        },
        request,
      );
      options.onCreated?.();
    }
    const session = await client.session.get({ sessionID }, request);
    if (session.agent !== input.agent || session.location.directory !== input.directory) {
      throw new Error(`Session ${sessionID} no longer runs agent ${input.agent} in ${input.directory}`);
    }
    if (input.permissions) await client.permission.rules({ sessionID, permissions: input.permissions }, request);
    if (wanted && !sameModel(session.model, wanted))
      await client.session.switchModel({ sessionID, model: wanted }, request);
  } catch (error) {
    throw new TurnNotStarted(error);
  }
  // Permission prompts park the turn until someone answers; nobody is at the server, so the policy
  // answers them as they are asked. Anything already pending from before this prompt is handled once.
  const rejected: TurnResult['rejected'] = [];
  const asks = new Set<string>();
  let failed: PermissionRequired | undefined;
  const failWith = (requests: { action: string; resources: string[] }[]) => {
    failed ??= new PermissionRequired(requests);
    parked.abort();
  };
  const parked = new AbortController();
  const answer = async (id: string, action: string, resources: string[]) => {
    if (asks.has(id)) return;
    asks.add(id);
    const summary = { action, resources: [...resources] };
    if (onPermission === 'fail') return failWith([summary]);
    await client.permission.reply({ sessionID, requestID: id, reply: 'reject' }, request);
    rejected.push(summary);
    log.warn('permission.rejected', { requests: [summary] });
  };
  let awaited = Promise.resolve();
  const unwatch = options.events.watch(sessionID, event => {
    if (event.type !== 'permission.asked') return;
    const { id, action, resources } = event.data as { id: string; action: string; resources: string[] };
    awaited = awaited
      .then(() => answer(id, action, resources))
      .catch(error => log.warn('permission.reply.failed', { error }));
  });
  try {
    await client.session.prompt(
      {
        sessionID,
        id: input.messageId,
        text: input.text,
        delivery: 'queue',
        metadata: messageMetadata,
      },
      request,
    );
    for (const p of await client.permission.list({ sessionID }, request))
      await answer(p.id, p.action, [...p.resources]);
    // The context can trail `wait` by a moment; every step of a session emits events, so the next one is the re-check.
    while (true) {
      await Promise.race([
        client.session.wait({ sessionID }, request),
        new Promise<never>((_, reject) =>
          parked.signal.addEventListener('abort', () => reject(failed), { once: true }),
        ),
      ]);
      if (failed) throw failed;
      await awaited;
      try {
        const text = finalAnswer(await client.session.context({ sessionID }, request), input.messageId, input.agent);
        return { sessionId: sessionID, text, rejected };
      } catch (error) {
        if (!(error instanceof PendingAnswer)) throw error;
        await nextEvent(options.events, sessionID, signal);
      }
    }
  } finally {
    unwatch();
  }
}

type ModelRef = { providerID: string; id: string; variant?: string };
const sameModel = (a: ModelRef | undefined, b: ModelRef) =>
  a !== undefined && a.providerID === b.providerID && a.id === b.id && (a.variant ?? undefined) === b.variant;

/**
 * The model the agent file declares, resolved by OpenCode; undefined when it declares none
 * (OpenCode's default then applies). `agent.list` with a location sees agents under that
 * directory's .opencode/, where `agent.get` does not.
 */
export async function agentModel(
  client: OpenCodeClient,
  agent: string,
  directory: string,
  request: { signal: AbortSignal },
): Promise<ModelRef | undefined> {
  const agents = await client.agent.list({ location: { directory } }, request);
  const model = agents.data.find(a => a.id === agent || a.name === agent)?.model;
  return model
    ? { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }
    : undefined;
}

/** Resolves on the next event of a session, or rejects when the signal aborts. */
function nextEvent(events: SessionEvents, sessionID: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      unwatch();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(signal.reason);
    };
    const unwatch = events.watch(sessionID, () => {
      done();
      resolve();
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Extract the confirmed final answer for one turn from the native session
 * context, or throw. `PendingAnswer` means keep waiting; any other error means
 * the turn cannot be trusted.
 */
export function finalAnswer(messages: NativeMessages, messageId: string, agent: string): string {
  const start = messages.findLastIndex(
    m =>
      m.type === 'user' &&
      (m.id === messageId || (m.metadata?.aivi as { message?: string } | undefined)?.message === messageId),
  );
  if (start < 0) throw new PendingAnswer('Submitted turn is not present in native context');
  const tail = messages.slice(start + 1);
  if (tail.some(m => m.type === 'user' || m.type === 'agent-switched'))
    throw new Error('Native session changed outside this turn');

  const idle = tail.findLast(m => m.type === 'idle');
  const answer = tail.findLast(m => m.type === 'assistant');
  if (!idle || !answer || answer.time.completed === undefined || tail.lastIndexOf(idle) < tail.lastIndexOf(answer)) {
    throw new PendingAnswer('Native turn is not complete');
  }
  if (idle.outcome !== 'succeeded' || answer.agent !== agent || answer.finish !== 'stop' || answer.error) {
    throw new Error(`No confirmed final answer (idle=${idle.outcome}, agent=${answer.agent}, finish=${answer.finish})`);
  }
  if (
    tail.some(
      m =>
        m.type === 'assistant' &&
        m.content.some(p => p.type === 'tool' && !['completed', 'error'].includes(p.state.status)),
    )
  ) {
    throw new Error('Native turn has unfinished tools');
  }
  const text = answer.content
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Final answer has no text');
  return text;
}
