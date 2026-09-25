/** `aivi link` — mint a one-time code that binds a channel account to the
 *  signed-in person. Pure HTTP: linking runs on the person's machine, which
 *  may have no installed server. The code is spent with `/link` on the
 *  channel; the reply there comes from the host, never from an agent.
 *  The host decides what may be minted — a running channel, one the person
 *  is not linked in yet — and this command only picks among what the host
 *  reports and renders the answer. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { aiviVersion } from './version.ts';

export interface LinkChannel {
  channel: string;
  hint?: string;
  /** This person already holds a binding in the channel. */
  linked: boolean;
}

export interface LinkMint {
  code: string;
  expiresAt: string;
  person: string;
  next: string;
}

export interface LinkIo {
  channels(url: string, token: string): Promise<LinkChannel[]>;
  mint(url: string, token: string, channel: string): Promise<LinkMint>;
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
  const connection = { url: config.url, token: config.person.token };
  const channels = await io.channels(connection.url, connection.token);

  if (platform !== undefined) {
    const requested = platform.toLowerCase();
    const known = channels.find(c => c.channel === requested);
    if (!known)
      throw new Error(
        `No channel module "${requested}" is running. Available: ${channels.map(c => c.channel).join(', ') || 'none'}.`,
      );
    if (known.linked) {
      said(io, `Already linked in the ${known.channel} channel.`, { channel: known.channel, linked: true });
      return;
    }
    await mintFor(io, connection, known.channel);
    return;
  }

  if (channels.length === 0) {
    said(io, 'No channel module is running yet. Start aivi, then run aivi link again.', { channels: [] });
    return;
  }
  const eligible = channels.filter(c => !c.linked);
  if (eligible.length === 0) {
    said(io, `Already linked everywhere aivi runs: ${channels.map(c => c.channel).join(', ')}.`, { channels });
    return;
  }
  const channel = eligible.length === 1 ? eligible[0]!.channel : await io.askPlatform(eligible);
  await mintFor(io, connection, channel);
}

/** One sentence on a terminal, the same fact as JSON in a pipe. */
function said(io: LinkIo, sentence: string, record: unknown): void {
  io.log(process.stdout.isTTY ? sentence : JSON.stringify(record, null, 2));
}

async function mintFor(io: LinkIo, connection: { url: string; token: string }, channel: string): Promise<void> {
  const result = await io.mint(connection.url, connection.token, channel);
  if (process.stdout.isTTY) {
    // The thin CLI ships without @aivi/core, so the terminal gets its own one
    // line: the host's instruction carries the code, the expiry is the
    // reader's clock. A pipe keeps the JSON record.
    const expires = new Date(result.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    io.log(`${result.next}  —  expires ${expires}`);
    return;
  }
  io.log(JSON.stringify({ ...result, channel }, null, 2));
}

async function channels(url: string, token: string): Promise<LinkChannel[]> {
  const response = await fetch(`${url}/links`, {
    headers: { 'x-aivi-client': aiviVersion, authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Listing the channels aivi runs failed: HTTP ${response.status}.`);
  const body = (await response.json()) as { channels?: unknown };
  return Array.isArray(body.channels) ? (body.channels as LinkChannel[]) : [];
}

async function mint(url: string, token: string, channel: string): Promise<LinkMint> {
  const response = await fetch(`${url}/links`, {
    method: 'POST',
    headers: { 'x-aivi-client': aiviVersion, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ channel }),
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 409) throw new Error(`Already linked in the ${channel} channel.`);
  if (response.status === 404) throw new Error(`No channel module "${channel}" is running.`);
  if (!response.ok) throw new Error(`Minting a link code failed: HTTP ${response.status}.`);
  return (await response.json()) as LinkMint;
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
      new Error(`Several channels are eligible; name one: aivi link ${channels.map(c => c.channel).join('|')}`),
    );
  return (async () => {
    const picked = await p.select({
      message: 'Where will you use the code?',
      options: channels.map(c => ({
        value: c.channel,
        ...(c.hint ? { hint: c.hint } : {}),
      })),
    });
    if (p.isCancel(picked)) throw new Error('No channel chosen; nothing was linked.');
    return picked;
  })();
}

const defaultIo: LinkIo = {
  channels,
  mint,
  askPlatform,
  log: message => console.log(message),
};
