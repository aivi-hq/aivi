import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Logger } from '@aivi/core';
import { getLogger } from '@aivi/core';
import type { LinearClient } from './client.ts';

const DEFAULT_UPSTREAM = 'https://mcp.linear.app/mcp';
/** Hop-by-hop and endpoint-local headers that must not travel upstream. */
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

export interface LinearMcpOptions {
  /** Loopback port to bind; `0` lets the OS pick one. */
  port: number;
  /** Upstream MCP endpoint; Linear's hosted server by default. */
  upstream?: string;
  log?: Logger;
}

/**
 * The Linear MCP: a loopback-only HTTP server, hosted by the linear module
 * itself, that bridges OpenCode's remote MCP connection to Linear's hosted
 * MCP. It forwards every request verbatim, rewriting only the authorization
 * header to the app-actor token minted by the module's own client — writes
 * attribute to the app, never a human. The token is re-minted once on a 401
 * (the app token lives 30 days with no refresh token; Linear's documented
 * pattern). Loopback only: the MCP can write to Linear as the app, so it is
 * never exposed beyond the machine.
 */
export class LinearMcp {
  private readonly client: LinearClient;
  private readonly port: number;
  private readonly upstream: URL;
  private readonly log: Logger;
  private server: Server | null = null;

  constructor(client: LinearClient, options: LinearMcpOptions) {
    this.client = client;
    this.port = options.port;
    this.upstream = new URL(options.upstream ?? DEFAULT_UPSTREAM);
    this.log = options.log ?? getLogger(['aivi', 'linear', 'mcp']);
  }

  /** Bind loopback; resolves with the actual port. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        this.handle(request, response).catch(error => {
          this.log.warn('linear.mcp.request_failed', { error });
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Upstream unreachable' } }),
          );
        });
      });
      this.server = server;
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The request body is an MCP message: small JSON, buffered so a 401 retry can replay it.
    const body = await readBody(request);
    await this.forward(request, response, body, false);
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
    retried: boolean,
  ): Promise<void> {
    // `retried` re-mints: the cached token was just refused upstream.
    const token = await this.client.accessToken(retried);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_HEADERS.has(name) && typeof value === 'string') headers[name] = value;
    }
    headers.authorization = `Bearer ${token}`;
    headers.host = this.upstream.host;
    const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      const upstreamRequest = this.upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = upstreamRequest(
        {
          hostname: this.upstream.hostname,
          port: this.upstream.port,
          path: `${this.upstream.pathname}${incoming.search}`,
          method: request.method,
          headers,
        },
        upstreamResponse => {
          if (upstreamResponse.statusCode === 401 && !retried) {
            upstreamResponse.resume();
            this.forward(request, response, body, true).then(() => resolve(), reject);
            return;
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          upstreamResponse.on('end', () => resolve());
          upstreamResponse.on('error', reject);
        },
      );
      upstream.on('error', reject);
      if (body.length) upstream.end(body);
      else upstream.end();
    });
  }
}

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
