import type { Hono } from 'hono';
import type { Store } from '../../store.ts';
import type { AppEnv } from '../env.ts';
import { capBody, looseJson, MAX_JOB_BODY, requireJson, respond } from '../http.ts';
import { requirePerson } from '../person.ts';

export interface LinkableChannel {
  id: string;
  hint?: string | undefined;
}

/**
 * `GET /links` lists the running channels and whether this person already
 * holds a binding in each; the CLI shows what is eligible before asking to
 * mint. `POST /links` mints a code for the channel its body names: no code
 * exists that no running module could read, and none is minted for a channel
 * the person is linked in already. There is no schema — the body names one
 * loose string and every other answer is a refusal.
 */
export function registerLinks(
  app: Hono<AppEnv>,
  deps: { store: Store; linkable?: (() => LinkableChannel[]) | undefined },
): void {
  const gate = requirePerson('Linking names a person; send a bearer token that resolves to one');
  app.get('/links', gate, c => {
    const person = c.get('person')!;
    const channels = deps.linkable?.() ?? [];
    return c.json({
      channels: channels.map(channel => ({
        channel: channel.id,
        ...(channel.hint ? { hint: channel.hint } : {}),
        linked: deps.store.personLinkedIn(channel.id, person.id),
      })),
    });
  });
  app.post('/links', gate, requireJson, capBody(MAX_JOB_BODY, 'Request is too large'), async c => {
    const person = c.get('person')!;
    const body = await looseJson(c);
    const channelId =
      typeof (body as { channel?: unknown } | null)?.channel === 'string' ? (body as { channel: string }).channel : '';
    const running = deps.linkable?.().find(channel => channel.id === channelId);
    if (!running) return respond({ error: `No channel module "${channelId || '<none>'}" is running` }, 404);
    if (deps.store.personLinkedIn(running.id, person.id))
      return respond({ error: `Already linked in the ${running.id} channel.` }, 409);
    const minted = deps.store.mintLinkCode(person.id);
    // `next` is the one instruction that follows: where this code is spent.
    return c.json({
      code: minted.code,
      expiresAt: new Date(minted.expiresAt).toISOString(),
      person: person.name,
      next: running.hint
        ? running.hint.replace(/<code>/, minted.code)
        : `Paste \`/link ${minted.code}\` in the ${running.id} channel the bot reads.`,
    });
  });
}
