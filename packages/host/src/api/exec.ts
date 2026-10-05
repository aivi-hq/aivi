/** The exec door: `/exec` as a websocket upgrade on the host's own HTTP
 *  server — the plan's protocol ([remote-exec.md](../../../../docs/plans/cli-refactor/remote-exec.md)).
 *  The wire carries terminal bytes and a few JSON control messages; the CLI
 *  itself is the protocol. `@aivi/cli` connects with its bearer, the host runs
 *  `aivi <argv>` as a child on a PTY (or with plain pipes when the client's
 *  stdout is not a TTY), and the payload is the human's terminal.
 *
 *  The upgrade never crosses hono — node hands it here directly — so the
 *  chain runs by hand in the same order the API runs it: version gate, bearer
 *  person, operator gate. The diary middleware cannot see this traffic
 *  either, so every arrival gets one audit line through `store.logRequest`
 *  instead: refusals carry the reason, sessions carry person, argv, source
 *  address and exit code. */
import { type ChildProcessWithoutNullStreams, spawn as spawnChild } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { LoadedConfig, Logger } from '@aivi/core';
import type { IPty } from 'node-pty';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Store } from '../store.ts';
import { hostVersion } from '../version.ts';
import { negotiate } from './gate.ts';
import { bearerPerson } from './person.ts';

/** The one command a remote person can run: this machine's `aivi`, found on
 *  PATH. Nothing else is ever spawned — "no shell access" is a mechanical
 *  property, not policy. */
const EXEC_COMMAND = 'aivi';

/** The client's first frame; every other client frame is terminal bytes. */
interface StartMessage {
  t: 'start';
  argv: string[];
  term?: string;
  cols?: number;
  rows?: number;
  /** False when the client's stdout is not a TTY: two pipes, JSON stays JSON. */
  pty?: boolean;
}

export interface ExecDeps {
  store: Store;
  loaded: LoadedConfig;
  log: Logger;
  /** The host aborts; every open session ends with it (gone is gone). */
  signal: AbortSignal;
  /** Injectable for tests: the PTY loader and the command on PATH. */
  importPty?: (() => Promise<typeof import('node-pty')>) | undefined;
  command?: string | undefined;
  /** The pipe-mode process factory. The door's protocol — the closed env it
   *  hands a child, the frames it relays, the kill on disconnect, the one
   *  child per session — is the unit under test here; whether the OS can
   *  spawn a process is the live gate's subject, so a test drives this seam
   *  instead of paying a real child. Defaults to node's own spawn. */
  spawnPipe?: (
    command: string,
    argv: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => ChildProcessWithoutNullStreams;
}

/** One live exec session: exactly one child, whichever mode the client asked for. */
interface Session {
  pty: IPty | null;
  pipe: ChildProcessWithoutNullStreams | null;
  /** A start still awaiting the pty import already owns the session: only
   *  the child this session holds has a kill handle, so a second start
   *  racing the import must be told, never spawned. */
  starting: boolean;
  /** Bytes split mid-character across frames rejoin here before the child. */
  stdin: StringDecoder;
  /** True once the child is gone; kills after that are lies worth skipping. */
  exited: boolean;
}

/**
 * Open the exec door on the host's HTTP server. The version gate, the bearer
 * and the operator role decide every connection; a session lives until its
 * child exits, the client disconnects, or the host aborts.
 */
export function attachExec(server: Server, deps: ExecDeps): void {
  const { store, loaded, log } = deps;
  const importPty = deps.importPty ?? (() => import('node-pty'));
  const command = deps.command ?? EXEC_COMMAND;
  const spawnPipe = deps.spawnPipe ?? ((name, argv, options) => spawnChild(name, argv, options));
  const home = dirname(loaded.path);
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<WebSocket, Session>();

  /** One diary line per arrival, refused or run — the audit the HTTP diary
   *  middleware cannot write for upgrades. */
  const audit = (req: IncomingMessage, status: number, entry: Record<string, unknown>): void => {
    try {
      store.logRequest({
        at: Date.now(),
        method: 'EXEC',
        path: '/exec',
        status,
        body: JSON.stringify(entry),
        truncated: false,
        headers: {
          ...(typeof req.headers['x-aivi-client'] === 'string'
            ? { 'x-aivi-client': req.headers['x-aivi-client'] }
            : {}),
          ...(req.headers.authorization ? { authorization: '[present]' } : {}),
        },
      });
    } catch (error) {
      // The diary failing is news, never a lost connection.
      log.warn('exec.audit.failed', { error });
    }
  };

  const refuse = (req: IncomingMessage, socket: Duplex, status: number, body: Record<string, unknown>): void => {
    audit(req, status, { ...body, address: req.socket.remoteAddress ?? null });
    const payload = JSON.stringify(body);
    socket.write(
      `HTTP/1.1 ${status} Refused\r\n` +
        `content-type: application/json\r\ncache-control: no-store\r\n` +
        `content-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
    );
    socket.destroy();
  };

  /** The child's closed environment: the audit evidence says
   *  which human drove, and nothing else from the host's secrets travels.
   *  PATH and HOME are what `aivi add` and `aivi update` need to exec npm and
   *  git; AIVI_OPERATOR_BEARER is the bearer this connection presented. */
  const execEnv = (bearer: string, term: string): Record<string, string> => ({
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? homedir(),
    ...(process.env.COLORTERM ? { COLORTERM: process.env.COLORTERM } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    AIVI_HOME: home,
    TERM: term,
    AIVI_OPERATOR_BEARER: bearer,
    // The machine fact this child runs under: it is the far end of an exec
    // session, so its own command declarations answer the guard lines (the
    // plan's sets) instead of acting on or fighting the machine.
    AIVI_EXEC_SESSION: '1',
  });

  const open = (ws: WebSocket, req: IncomingMessage, person: { id: string; name: string }, bearer: string): void => {
    const address = req.socket.remoteAddress ?? null;
    const session: Session = {
      pty: null,
      pipe: null,
      starting: false,
      stdin: new StringDecoder('utf8'),
      exited: false,
    };
    sessions.set(ws, session);
    let audited = false;
    const send = (message: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    /** One audit line per session, written once: at the child's exit, or at
     *  a close that never got a child. */
    const finish = (exitCode: number | null, extra: Record<string, unknown> = {}): void => {
      if (audited) return;
      audited = true;
      sessions.delete(ws);
      audit(req, 101, { person, address, exitCode, ...extra });
    };
    const kill = (): void => {
      if (session.exited) return;
      session.pty?.kill();
      session.pipe?.kill('SIGTERM');
    };

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const bytes = session.stdin.write(data);
        if (!bytes || session.exited) return;
        if (session.pty) session.pty.write(bytes);
        else session.pipe?.stdin.write(bytes);
        return;
      }
      control(data.toString('utf8'));
    });

    const control = (text: string): void => {
      let message: { t?: unknown; cols?: unknown; rows?: unknown };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        send({ t: 'error', message: 'expected one JSON start message' });
        return;
      }
      if (message?.t === 'resize') {
        const size = terminalSize(message);
        if (session.pty) session.pty.resize(size.cols, size.rows);
        return;
      }
      void start(message as StartMessage);
    };

    const start = async (message: StartMessage): Promise<void> => {
      if (session.starting || session.pty || session.pipe) return send({ t: 'error', message: 'start sent twice' });
      const valid =
        message?.t === 'start' &&
        Array.isArray(message.argv) &&
        message.argv.length > 0 &&
        message.argv.every(arg => typeof arg === 'string') &&
        (message.pty === undefined || message.pty === false || message.pty === true);
      if (!valid) return send({ t: 'error', message: 'start needs a non-empty string argv' });
      // The session is claimed before its first await: a second start frame
      // racing the pty import finds this line, not a second child.
      session.starting = true;
      const env = execEnv(bearer, message.term ?? 'xterm-256color');
      if (message.pty === false) return pipeSession(message.argv, env);
      try {
        await ptySession(message, env);
      } catch (error) {
        log.warn('exec.unavailable', { error });
        // The plan's degradation: the host answers exec attempts plainly, and
        // local commands never notice (node-pty is a server-side dependency).
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from('remote exec unavailable on this host\n', 'utf8'));
        send({ t: 'exit', code: 1 });
        ws.close();
        finish(1, { argv: message.argv, reason: 'pty unavailable' });
      }
    };

    const ptySession = async (message: StartMessage, env: Record<string, string>): Promise<void> => {
      const pty = await importPty();
      repairSpawnHelper(import.meta.url);
      const child = pty.spawn(command, message.argv, {
        name: message.term ?? 'xterm-256color',
        cols: terminalSize(message).cols,
        rows: terminalSize(message).rows,
        cwd: home,
        env,
      });
      session.pty = child;
      send({ t: 'ready', pid: child.pid });
      child.onData(data => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'));
      });
      child.onExit(({ exitCode }) => {
        session.exited = true;
        send({ t: 'exit', code: exitCode });
        ws.close();
        finish(exitCode, { argv: message.argv });
      });
    };

    const pipeSession = (argv: string[], env: Record<string, string>): void => {
      const child = spawnPipe(command, argv, { cwd: home, env });
      session.pipe = child;
      send({ t: 'ready', pid: child.pid });
      child.stdout.on('data', (chunk: Buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk);
      });
      // stdout keeps the binary channel (a pipe gets JSON untouched); stderr
      // rides base64 so the client keeps the two apart, which a PTY cannot.
      child.stderr.on('data', (chunk: Buffer) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'err', b64: chunk.toString('base64') }));
      });
      child.stdin.on('error', () => {}); // stdin after death is EPIPE; the exit says it
      child.on('error', error => {
        session.exited = true;
        log.warn('exec.unavailable', { error });
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from('remote exec unavailable on this host\n', 'utf8'));
        send({ t: 'exit', code: 1 });
        ws.close();
        finish(1, { argv, reason: 'spawn failed' });
      });
      child.on('close', code => {
        session.exited = true;
        if (audited) return; // `error` answered already; one exit line only
        send({ t: 'exit', code });
        ws.close();
        finish(code, { argv });
      });
    };

    // Socket close ⇒ the child dies: a disconnect never leaves a process
    // driving the server behind the client's back.
    ws.on('close', () => {
      kill();
      finish(null, { reason: 'connection closed' });
    });
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://exec.local').pathname;
    if (path !== '/exec') return refuse(req, socket, 404, { error: 'Not found' });
    const client = req.headers['x-aivi-client'];
    const outcome = negotiate(typeof client === 'string' ? client : undefined, hostVersion);
    if (!outcome.ok)
      return refuse(req, socket, 403, { code: outcome.code, minVersion: outcome.minVersion, error: outcome.error });
    const person = bearerPerson(store, req.headers.authorization);
    if (!person) return refuse(req, socket, 401, { error: 'Remote exec names who you are; send a bearer token' });
    if (!person.roles.includes('operator'))
      return refuse(req, socket, 403, {
        error: 'Only an operator can drive this host remotely',
        person: { id: person.id, name: person.name },
      });
    // The bearer this connection already presented, re-exported into the
    // child so `whoami`, link creation and association name the remote human,
    // never the server's own client-config token.
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    wss.handleUpgrade(req, socket, head, ws => open(ws, req, { id: person.id, name: person.name }, bearer));
  });

  deps.signal.addEventListener(
    'abort',
    () => {
      // Stop means stop: sessions die with the host, children with them.
      for (const [ws, session] of sessions) {
        if (!session.exited) {
          session.pty?.kill();
          session.pipe?.kill('SIGTERM');
        }
        ws.terminate();
      }
      sessions.clear();
      wss.close();
    },
    { once: true },
  );
}

/** Terminal size from the start/resize message; sane defaults, absurd values
 *  fall back rather than corrupt the PTY's window struct. */
function terminalSize(message: { cols?: unknown; rows?: unknown }): { cols: number; rows: number } {
  const dim = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000 ? value : undefined;
  return { cols: dim(message.cols) ?? 80, rows: dim(message.rows) ?? 24 };
}

/** node-pty's macOS prebuild ships `spawn-helper` without the execute bit in
 *  the npm tarball, and its own install scripts never touch the `prebuilds/`
 *  copy; posix_spawnp needs +x. One repair per process; when it cannot happen
 *  the spawn fails and the honest degradation answers. (VS Code patches the
 *  same broken artifact at its build step; we do it at ours.) */
let helperRepaired = false;
function repairSpawnHelper(from: string): void {
  if (helperRepaired || process.platform !== 'darwin') return;
  helperRepaired = true;
  try {
    // Resolve through node-pty's own main: hoisted installs put it at the
    // repo root or the home's appDir, and both are answers, not guesses.
    const main = createRequire(from).resolve('node-pty');
    const helper = join(
      dirname(dirname(main)),
      'prebuilds',
      `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
      'spawn-helper',
    );
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // Read-only install; the spawn below fails and says so.
  }
}
