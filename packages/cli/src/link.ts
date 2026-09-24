/** `aivi link` — mint a one-time code that binds a channel account to the
 *  signed-in person. Pure HTTP: linking runs on the person's machine, which
 *  may have no installed server. The code is spent with `/link` on the
 *  channel; the reply there comes from the host, never from an agent. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';

export interface LinkChannel {
  id: string;
  hint?: string;
}

export interface LinkResult {
  code: string;
  expiresAt: string;
  person: string;
  channels: LinkChannel[];
  next: string;
}

export interface LinkIo {
  mint(url: string, token: string): Promise<LinkResult>;
  askPlatform(channels: LinkChannel[]): Promise<string>;
  log(message: string): void;
}

export function extractLinkArgs(args: string[]): { platform: string | undefined } {
  if (args.length > 1) throw new Error('Usage: aivi link [PLATFORM]');
  return { platform: args[0] };
}

export async function link(args: string[], io: LinkIo = defaultIo): Promise<void> {
  const { platform } = extractLinkArgs(args);
  const config = loadClientConfig();
  if (!config?.url || !config.person?.token)
    throw new Error('This machine has not signed in. Run `aivi setup` first; linking names a person.');
  const result = await io.mint(config.url, config.person.token);

  let channel = platform?.toLowerCase();
  if (channel !== undefined) {
    const known = result.channels.find(c => c.id === channel);
    if (!known)
      throw new Error(
        `No channel module "${channel}" is running. Available: ${result.channels.map(c => c.id).join(', ') || 'none'}.`,
      );
  } else if (result.channels.length > 1) channel = await io.askPlatform(result.channels);
  else channel = result.channels[0]?.id;

  const hint = result.channels.find(c => c.id === channel)?.hint;
  // `next` is the one instruction: exactly where and how the code is spent.
  const next = hint
    ? `${hint.replace(/<code>/, result.code)} (${result.expiresAt.slice(0, 16).replace('T', ' ')} UTC)`
    : result.next;
  io.log(
    JSON.stringify(
      { code: result.code, expiresAt: result.expiresAt, person: result.person, ...(channel ? { channel } : {}), next },
      null,
      2,
    ),
  );
}

async function mint(url: string, token: string): Promise<LinkResult> {
  const response = await fetch(`${url}/v1/links`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401)
    throw new Error('That token does not name a person. Copy it again from `aivi people token` (it is shown once).');
  if (!response.ok) throw new Error(`Minting a link code failed: HTTP ${response.status}.`);
  return (await response.json()) as LinkResult;
}

/** The client config `aivi setup` writes; read as a file, no host imports. */
function loadClientConfig(): { url?: string; person?: { token?: string } } | undefined {
  // AIVI_CONFIG moves the whole record (a development home signs in its own copy).
  const path = process.env.AIVI_CONFIG
    ? resolve(process.env.AIVI_CONFIG)
    : resolve(process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? '', '.config'), 'aivi.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { url?: string; person?: { token?: string } };
  } catch {
    return undefined;
  }
}

function askPlatform(channels: LinkChannel[]): Promise<string> {
  if (!process.stdin.isTTY)
    return Promise.reject(
      new Error(`Several channels are running; name one: aivi link ${channels.map(c => c.id).join('|')}`),
    );
  return (async () => {
    const picked = await p.select({
      message: 'Where will you use the code?',
      options: channels.map(c => ({
        value: c.id,
        ...(c.hint ? { hint: c.hint } : {}),
      })),
    });
    if (p.isCancel(picked)) throw new Error('No channel chosen; nothing was linked.');
    return picked;
  })();
}

export const defaultIo: LinkIo = {
  mint,
  askPlatform,
  log: message => console.log(message),
};
