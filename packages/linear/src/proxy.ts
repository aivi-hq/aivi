import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { LinearClient } from './client.ts';

/**
 * The Linear MCP proxy: a stdio MCP server that forwards to Linear's hosted
 * MCP carrying an *app actor* token, so agent writes attribute to the app,
 * never to a human. OpenCode's documented `type: "local"` spawns it per
 * config with its own environment; the proxy is stateless beyond the
 * upstream session id and the in-memory token (`LinearClient` mints it at
 * start and re-mints once on a 401 — the app token lives 30 days with no
 * refresh token, Linear's documented pattern).
 *
 * Credentials come from the environment (the bare `LINEAR_*` names — the
 * primary app); when the proxy was not started by aivi it reads them from
 * `<AIVI_HOME>/.env` itself. Protocol: newline-delimited JSON-RPC 2.0 on
 * stdin and stdout, everything else on stderr.
 */

const DEFAULT_UPSTREAM = 'https://mcp.linear.app/mcp';

/** The proxy as a callable: reads one JSON-RPC line, writes upstream replies. Exported for tests. */
export class LinearMcpProxy {
  private readonly client: LinearClient;
  private readonly upstream: string;
  private sessionId: string | undefined;

  constructor(client: LinearClient, upstream = DEFAULT_UPSTREAM) {
    this.client = client;
    this.upstream = upstream;
  }

  /** Send one message upstream; a 401 re-mints the token once and retries. */
  private async send(message: unknown, retried = false): Promise<Response> {
    const token = await this.client.accessToken();
    const response = await fetch(this.upstream, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    if (response.status === 401 && !retried) {
      await this.client.accessToken(true);
      return this.send(message, true);
    }
    return response;
  }

  /** Handle one line of stdin; returns the lines to write to stdout (possibly none). */
  async handle(line: string): Promise<string[]> {
    const text = line.trim();
    if (!text) return [];
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return [this.error(null, -32700, 'Parse error')];
    }
    let response: Response;
    try {
      response = await this.send(message);
    } catch (error) {
      return [
        this.error(
          typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null,
          -32603,
          `Upstream unreachable: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ];
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (response.status === 202 || response.headers.get('content-length') === '0') return [];
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : null;
    if (!response.ok) return [this.error(id, -32603, `Upstream ${response.status}`)];
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (!contentType.includes('text/event-stream')) return this.responses(body);
    // A streamable-HTTP reply: one or more `data:` events, each a JSON-RPC message.
    const out: string[] = [];
    for (const event of body.split('\n\n')) {
      for (const row of event.split('\n')) {
        if (row.startsWith('data:')) out.push(...this.responses(row.slice(5).trim()));
      }
    }
    return out;
  }

  /** Parse a body of one or more JSON messages; drop anything that is not JSON. */
  private responses(body: string): string[] {
    const out: string[] = [];
    for (const part of body.split('\n')) {
      const text = part.trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed !== null && typeof parsed === 'object') out.push(JSON.stringify(parsed));
      } catch {
        // Upstream noise is not protocol; the client never sees it.
      }
    }
    return out;
  }

  private error(id: unknown, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

/** Credentials from the environment, or `<AIVI_HOME>/.env` when run outside aivi's process. */
export function proxyCredentials(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
  let clientId = env.LINEAR_CLIENT_ID;
  let clientSecret = env.LINEAR_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  const home = env.AIVI_HOME ?? join(process.env.HOME ?? '', '.aivi');
  try {
    for (const line of readFileSync(join(home, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match?.[1]) continue;
      const name = match[1];
      const value = (match[2] ?? '').replace(/^["']|["']$/g, '');
      if (name === 'LINEAR_CLIENT_ID' && !clientId) clientId = value;
      if (name === 'LINEAR_CLIENT_SECRET' && !clientSecret) clientSecret = value;
    }
  } catch {
    // No .env: the error below names what is missing.
  }
  if (!clientId || !clientSecret)
    throw new Error(
      `Linear MCP proxy: set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET in the environment or ${join(home, '.env')}`,
    );
  return { clientId, clientSecret };
}
async function main(): Promise<void> {
  const { clientId, clientSecret } = proxyCredentials();
  const client = new LinearClient({ clientId, clientSecret });
  const proxy = new LinearMcpProxy(client, process.env.LINEAR_MCP_URL ?? DEFAULT_UPSTREAM);
  const stderr = (message: string) => process.stderr.write(`${message}\n`);
  const stdin = createInterface({ input: process.stdin, terminal: false });
  const pending = new Set<Promise<unknown>>();
  stdin.on('line', line => {
    const work = proxy
      .handle(line)
      .then(out => {
        for (const row of out) process.stdout.write(`${row}\n`);
      })
      .catch(error => stderr(`linear-mcp-proxy: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  stdin.on('close', () => {
    void Promise.allSettled([...pending]).then(() => process.exit(0));
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

/* Run when executed directly; imported for tests otherwise. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`linear-mcp-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
