import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a webhook's own timestamp may be from now before it is treated as a replay. */
export const WEBHOOK_MAX_SKEW_MS = 60_000;

export type WebhookVerdict = { ok: true; payload: LinearWebhook } | { ok: false; status: number; reason: string };

/** The parts of an `AgentSessionEvent` payload the module reads. Untrusted input. */
export interface AgentSessionEventPayload {
  type: 'AgentSessionEvent';
  action: 'created' | 'prompted';
  organizationId: string;
  oauthClientId?: string;
  appUserId?: string;
  webhookTimestamp: number;
  agentSession: {
    id: string;
    status?: string;
    issue?: { id: string; identifier?: string; title?: string; team?: { id: string; key?: string } } | null;
    comment?: { id: string } | null;
  };
  agentActivity?: {
    id: string;
    content?: { type?: string; body?: string };
    signal?: string | null;
  };
  promptContext?: string;
  guidance?: unknown;
  previousComments?: unknown;
}

/** An issue data-change payload; the listener reads state and label changes. */
export interface IssueEventPayload {
  type: 'Issue';
  action: 'create' | 'update' | 'remove';
  organizationId: string;
  webhookTimestamp: number;
  data: {
    id: string;
    identifier?: string;
    title?: string;
    stateId?: string;
    state?: { id: string; name: string; type?: string };
    labelIds?: string[];
    labels?: { id: string; name: string }[];
    projectId?: string | null;
    project?: { id: string; name?: string } | null;
    teamId?: string;
    delegateId?: string | null;
    branchName?: string;
  };
  updatedFrom?: Record<string, unknown>;
  url?: string;
}

export interface OtherPayload {
  type: string;
  action: string;
  organizationId?: string;
  webhookTimestamp: number;
}

export type LinearWebhook = AgentSessionEventPayload | IssueEventPayload | OtherPayload;

/**
 * Verify one delivery the way Linear documents it: HMAC-SHA256 of the raw
 * body with the app's webhook signing secret, compared in constant time
 * against `Linear-Signature`, then the payload's own `webhookTimestamp`
 * within a minute of now. The body is parsed only after both hold.
 */
export function verifyWebhook(input: {
  body: Buffer;
  signature: string | string[] | undefined;
  secret: string;
  now?: number;
}): WebhookVerdict {
  const header = Array.isArray(input.signature) ? input.signature[0] : input.signature;
  if (!header) return { ok: false, status: 401, reason: 'missing Linear-Signature' };
  const expected = createHmac('sha256', input.secret).update(input.body).digest();
  const provided = Buffer.from(header, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    return { ok: false, status: 401, reason: 'signature mismatch' };
  let payload: unknown;
  try {
    payload = JSON.parse(input.body.toString('utf8'));
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }
  if (!isRecord(payload) || typeof payload.type !== 'string' || typeof payload.action !== 'string')
    return { ok: false, status: 400, reason: 'payload has no type/action' };
  const ts = payload.webhookTimestamp;
  if (typeof ts !== 'number') return { ok: false, status: 400, reason: 'payload has no webhookTimestamp' };
  if (Math.abs((input.now ?? Date.now()) - ts) > WEBHOOK_MAX_SKEW_MS)
    return { ok: false, status: 401, reason: 'webhookTimestamp outside the replay window' };
  return { ok: true, payload: payload as unknown as LinearWebhook };
}

export const isAgentSessionEvent = (p: LinearWebhook): p is AgentSessionEventPayload =>
  p.type === 'AgentSessionEvent' && (p.action === 'created' || p.action === 'prompted');
export const isIssueEvent = (p: LinearWebhook): p is IssueEventPayload => p.type === 'Issue';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Sign a body the way Linear does; tests and the live check use it. */
export function signWebhook(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
