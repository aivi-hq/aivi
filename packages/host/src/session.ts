import { setTimeout } from 'node:timers/promises';
import type { Logger } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import type { OpenCodeClient } from './opencode.ts';

type NativeMessages = Awaited<ReturnType<OpenCodeClient['session']['context']>>;
type PermissionRule = { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' };
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Metadata = Record<string, Json>;

/** Thrown while a turn is still running; callers keep waiting. */
export class PendingAnswer extends Error {}
/** The agent asked for a permission and the policy was `fail`. The session stays inspectable. */
export class PermissionRequired extends Error {
  readonly requests: { action: string; resources: string[] }[];
  constructor(requests: { action: string; resources: string[] }[]) {
    super(`Agent requires approval: ${requests.map(r => `${r.action} ${r.resources.join(', ')}`).join('; ')}`);
    this.requests = requests;
  }
}

/** The native ids a job's turn uses, derived from the job id so a lost response has a known target. */
export function turnIdsFor(jobId: string): { sessionId: string; messageId: string } {
  const suffix = jobId.replaceAll('-', '');
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
  model?: { providerID: string; modelID: string };
}

export interface TurnOptions {
  signal: AbortSignal;
  /**
   * What to do when the agent asks for a permission nobody is there to grant.
   * `reject` (default for unattended work): deny and let the agent continue.
   * `fail`: throw `PermissionRequired`, leaving the prompt pending for a human.
   */
  onPermission?: 'reject' | 'fail';
  pollMs?: number;
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
  const pollMs = options.pollMs ?? 1000;
  const sessionID = input.sessionId;
  const request = { signal };

  if (input.create) {
    await client.session.create(
      {
        id: sessionID,
        agent: input.agent,
        location: { directory: input.directory },
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

  const aivi = input.messageMetadata?.aivi;
  const messageMetadata: Metadata = {
    ...input.messageMetadata,
    aivi: { ...(aivi && typeof aivi === 'object' && !Array.isArray(aivi) ? aivi : {}), message: input.messageId },
  };
  await client.session.prompt(
    {
      sessionID,
      id: input.messageId,
      text: input.text,
      delivery: 'queue',
      metadata: messageMetadata,
      ...(input.model ? { model: input.model } : {}),
    },
    request,
  );

  const rejected: TurnResult['rejected'] = [];
  let waited = client.session.wait({ sessionID }, request).then(() => true);
  while (true) {
    const finished = await Promise.race([waited, setTimeout(pollMs, false, { signal })]);
    const pending = await client.permission.list({ sessionID }, request);
    if (pending.length) {
      const summary = pending.map(p => ({ action: p.action, resources: [...p.resources] }));
      if (onPermission === 'fail') throw new PermissionRequired(summary);
      for (const p of pending) await client.permission.reply({ sessionID, requestID: p.id, reply: 'reject' }, request);
      rejected.push(...summary);
      log.warn('permission.rejected', { requests: summary });
    }
    if (!finished) continue;
    try {
      const text = finalAnswer(await client.session.context({ sessionID }, request), input.messageId, input.agent);
      return { sessionId: sessionID, text, rejected };
    } catch (error) {
      if (!(error instanceof PendingAnswer)) throw error;
      // wait() returned but the context does not show a finished turn yet (lag, or another step
      // started). wait() resolves at once for an idle session, so pace the re-check before re-arming.
      await setTimeout(pollMs, undefined, { signal });
      waited = client.session.wait({ sessionID }, request).then(() => true);
    }
  }
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
