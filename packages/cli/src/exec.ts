/** `aivi -r <command>` — drive the configured server with the very command
 *  you would type there. The exec channel carries terminal bytes and a few
 *  JSON control messages; the server runs this same CLI as its child, so
 *  the CLI itself is the protocol and the payload is the human's terminal.
 *
 *  Raw mode on, bytes forwarded, `SIGWINCH` resent as `resize`, and the
 *  terminal **restored on every exit path** — that is the ctrl+c lesson,
 *  applied on the client where it belongs. When this side's stdout is not a
 *  TTY (`aivi status | jq` from a laptop) the session asks for pipes instead
 *  of a PTY and JSON stays JSON (decision D12). */
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { type ClientConfig, clientConfigPath, clientConfigSchema } from './client-config.ts';
import { aiviVersion } from './version.ts';

/** Injectable for tests; the relay otherwise speaks for the real terminal.
 *  `isTTY` is what decides PTY vs pipes (decision D12), so the streams are
 *  typed where that question is answerable. */
export interface ExecIo {
  stdout?: (NodeJS.WritableStream & { isTTY?: boolean }) | undefined;
  stderr?: NodeJS.WritableStream | undefined;
}

/**
 * Open the exec channel, relay argv, print the answer. Throws the honest
 * failure — nothing here ever falls back to local execution: someone who
 * asked for remote gets the server's answer or the server's refusal, never
 * a different machine's output.
 */
export async function execRemote(argv: string[], io: ExecIo = {}): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  // The relay *signs* with the record — its words are load-bearing — so it
  // reads the bytes itself: the module's loader is lenient, and an
  // unloadable record reading as none is right for a hint and wrong for a
  // signature. Here a file that does not load fails by name.
  const path = clientConfigPath();
  let config: ClientConfig | undefined;
  if (existsSync(path)) {
    try {
      config = clientConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    } catch {
      throw new Error(
        `the client record at ${path} does not load; \`aivi configure\` edits it, \`aivi setup\` signs in again`,
      );
    }
  }
  const url = config?.url;
  const token = config?.person?.token;
  if (!url || !token) throw new Error('no server configured — run aivi setup');
  const endpoint = new URL('/exec', url);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(endpoint, {
    headers: { 'x-aivi-client': aiviVersion, authorization: `Bearer ${token}` },
  });

  // The refusal body is the whole reason this file imports `ws`: the
  // web-standard client swallows it (no status, no body), and D23 promised
  // the server's honest answer, not this CLI's guess at it.
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => (text += chunk));
      response.on('end', () => {
        // Something between here and the door (a proxy) may answer in HTML;
        // the status line is the honest floor, the door's JSON the norm.
        let refusal: { error?: string; message?: string };
        try {
          refusal = JSON.parse(text) as typeof refusal;
        } catch {
          refusal = {};
        }
        reject(
          new Error(refusal.error ?? refusal.message ?? `the server refused this connection (${response.statusCode})`),
        );
      });
    });
    ws.once('error', () => reject(new Error(`host unreachable at ${url}`)));
    ws.once('open', () => resolve());
  });
  await opened;

  const piped = stdout.isTTY !== true;
  const terminal = !piped && process.stdin.isTTY === true;
  /** Whatever the terminal teardown is when this process leaves by any
   *  path; the `exit` event is the guarantee, the explicit call the courtesy. */
  let undo = (): void => {};
  process.once('exit', () => undo());

  const code = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const sendResize = (): void => {
      if (ws.readyState === ws.OPEN)
        ws.send(JSON.stringify({ t: 'resize', cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }));
    };
    ws.on('error', () => {}); // the close that follows says it
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return void stdout.write(data);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } catch {
        return void stderr.write(data); // not a control frame; the bytes are the answer
      }
      if (message.t === 'exit') return settle(() => resolve(typeof message.code === 'number' ? message.code : 1));
      if (message.t === 'err') return void stderr.write(Buffer.from(String(message.b64), 'base64'));
      if (message.t === 'error') return void stderr.write(`${String(message.message)}\n`);
    });
    // Gone is gone (decision D13): no retry, no resume. The client says so
    // and exits with whatever it has; the next command finds out about the host.
    ws.on('close', () => settle(() => reject(new Error('connection lost'))));

    if (terminal) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (chunk: Buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });
      process.stdout.on('resize', sendResize);
      undo = () => {
        process.stdout.removeListener('resize', sendResize);
        if (process.stdin.isRaw) process.stdin.setRawMode(false);
        process.stdin.pause();
      };
    }
    const start: Record<string, unknown> = { t: 'start', argv };
    if (piped) start.pty = false;
    else {
      start.term = process.env.TERM ?? 'xterm-256color';
      start.cols = process.stdout.columns ?? 80;
      start.rows = process.stdout.rows ?? 24;
    }
    ws.send(JSON.stringify(start));
  });
  undo();
  process.exitCode = code;
}
