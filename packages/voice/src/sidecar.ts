/** One stdio child speaking JSONL: the process half the engine clients
 *  share. It spawns the command, waits for the ready marker on stderr,
 *  frames stdout into protocol messages and says how the process ended.
 *  What the messages MEAN is each client's own protocol. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

export type SidecarLog = {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
};

export interface SidecarSpec {
  command: string;
  args: string[];
  /** stderr text that means the models are loaded and stdin is read. */
  readyMarker: string;
}

export interface SidecarOptions {
  /** The client's log names start with this (`voice.batch`). */
  prefix: string;
  /** What an exit before the ready marker calls the process (`batch engine`). */
  title: string;
  spec: SidecarSpec;
  /** The child's environment beside the host's own: the model names. */
  env: Record<string, string>;
  log: SidecarLog;
}

export interface SidecarHandlers {
  /** One stdout line that is a protocol message — a JSON object. */
  onMessage(message: Record<string, unknown>, line: string): void;
  /** The ready marker appeared; `start` resolves right after this. */
  onReady?(): void;
  /** The process is gone, however it went: nothing more will be answered. */
  onGone(): void;
  /** It was ready and nobody stopped it: it ended on its own. */
  onExit(code: number | null): void;
}

/** One stdout line as a protocol message. Every message is a JSON object:
 *  anything else is a bad line before a single field is looked at. Throws
 *  for a line that is not one. */
function objectMessage(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('an engine message must be an object');
  return value as Record<string, unknown>;
}

export class Sidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private readonly options: SidecarOptions;
  private readonly handlers: SidecarHandlers;

  constructor(options: SidecarOptions, handlers: SidecarHandlers) {
    this.options = options;
    this.handlers = handlers;
  }

  /** The process is running: it was spawned and neither exited nor was stopped. */
  get alive(): boolean {
    return this.child !== null;
  }

  /** Spawn the process. Resolves when the ready marker appeared; rejects if
   *  it exited or could not be spawned first. */
  start(): Promise<void> {
    this.stopped = false;
    const { prefix, title, spec, env, log } = this.options;
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      this.child = child;
      let ready = false;
      let stderrBuf = '';
      let stdoutBuf = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        stderrBuf = (stderrBuf + d).slice(-8192);
        if (!ready && stderrBuf.includes(spec.readyMarker)) {
          ready = true;
          this.handlers.onReady?.();
          resolve();
        }
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        stdoutBuf += d;
        // bounded by the buffer: every pass consumes one line, and a
        // buffer without a newline ends the loop
        for (let i = stdoutBuf.indexOf('\n'); i >= 0; i = stdoutBuf.indexOf('\n')) {
          const line = stdoutBuf.slice(0, i).trim();
          stdoutBuf = stdoutBuf.slice(i + 1);
          if (line) this.receive(line);
        }
      });
      child.on('exit', code => {
        this.child = null;
        this.handlers.onGone();
        if (!ready) {
          ready = true;
          const tail = stderrBuf.slice(-400).trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`${title} exited ${code} before ready: ${tail || 'no stderr'}`));
          return;
        }
        if (!this.stopped) this.handlers.onExit(code);
      });
      // A dead process must not turn a write into an unhandled stream error.
      child.stdin.on('error', err => log.warn(`${prefix}.stdin-error`, { error: String(err) }));
      child.on('error', err => {
        log.warn(`${prefix}.spawn-failed`, { error: String(err) });
        if (!ready) {
          ready = true;
          reject(err);
        }
      });
    });
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = objectMessage(line);
    } catch {
      this.badLine(line);
      return;
    }
    this.handlers.onMessage(message, line);
  }

  /** A line the protocol has no use for: said, bounded, never acted on. */
  badLine(line: string): void {
    this.options.log.warn(`${this.options.prefix}.bad-line`, { line: line.slice(0, 120) });
  }

  /** One line to stdin. False when the pipe is full and the writer should
   *  hold back until `drained`; a process that is gone takes nothing and
   *  holds nobody back. */
  write(line: string): boolean {
    return this.child?.stdin.write(line) ?? true;
  }

  /** Call back once when a full stdin pipe has room again. */
  drained(resume: () => void): void {
    this.child?.stdin.once('drain', resume);
  }

  /** No more input is coming: the process may finish what it has. */
  endInput(): void {
    this.child?.stdin.end();
  }

  /** End the process now. Its exit is ours: nobody is told it died. */
  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGKILL');
  }
}
