import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import { type AudioSource, type EngineEvent, EngineRun, type EngineSpec } from '../src/engine.ts';

function child(t: TestContext) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const inputs: string[] = [];
  const unread: string[] = [];
  const readers: Array<(input: string) => void> = [];
  let writable = true;
  const write = t.mock.method(stdin, 'write', (input: string | Uint8Array) => {
    const line = typeof input === 'string' ? input : Buffer.from(input).toString();
    inputs.push(line);
    const read = readers.shift();
    if (read) read(line);
    else unread.push(line);
    return writable;
  });
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: t.mock.fn<(signal?: NodeJS.Signals) => boolean>(),
  });
  const exit = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
    process.exitCode = code;
    process.signalCode = signal;
    process.emit('exit', code, signal);
  };
  process.kill.mock.mockImplementation(signal => {
    exit(null, signal ?? 'SIGTERM');
    return true;
  });
  const nextInput = (): Promise<string> => {
    const line = unread.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise(resolve => readers.push(resolve));
  };
  const response = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  const ready = () => stderr.write('engine ready\n');
  const backpressure = (value: boolean) => {
    writable = !value;
  };
  return { process, stdin, stdout, stderr, write, inputs, nextInput, response, ready, exit, backpressure };
}

/** Process-shaped streams and explicit events. The named ESM spawn binding
 *  is replaced too; no child program or decoder can escape this fixture. */
export function voiceProcesses(t: TestContext) {
  const children: ReturnType<typeof child>[] = [];
  const created = Promise.withResolvers<void>();
  const spawn = t.mock.method(
    childProcess,
    'spawn',
    (_command: string, _args: readonly string[]): ChildProcessWithoutNullStreams => {
      const next = child(t);
      children.push(next);
      created.resolve();
      return next.process as unknown as ChildProcessWithoutNullStreams;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    for (const c of children) {
      if (c.process.exitCode === null && c.process.signalCode === null) c.exit();
      c.stdin.destroy();
      c.stdout.destroy();
      c.stderr.destroy();
    }
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return { children, spawn, created: created.promise };
}

export const engineSpec = { command: 'fake-engine', args: [], readyMarker: 'engine ready' };

export function engineFixture(t: TestContext, spec: EngineSpec = engineSpec, input: AudioSource = { type: 'push' }) {
  const h = voiceProcesses(t);
  const info = t.mock.fn();
  const warn = t.mock.fn();
  const events = t.mock.fn<(event: EngineEvent) => void>();
  const exited = t.mock.fn<(code: number | null) => void>();
  const run = new EngineRun(spec, input, { onEvent: events, onExit: exited }, { info, warn });
  t.after(() => run.stop());
  const start = async () => {
    const pending = run.start();
    h.children[0]!.ready();
    await pending;
  };
  return { ...h, info, warn, events, exited, run, start };
}
