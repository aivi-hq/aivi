import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { configSchema } from '@aivi/core';
import { Command } from 'commander';

/** A loaded config: core's defaults with whatever a test names on top. The
 *  path is a plain string no unit reads. */
export function loadedWith(config: Record<string, unknown> = {}, rest: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    path: '/aivi-home/config.json',
    config: configSchema.parse({ version: 1, ...config }),
    projects: [],
    sources: [],
    ...rest,
  };
}

/** One command line parsed the way the bin parses it, over a fresh tree that
 *  holds only what `register` mounts. A refusal rejects instead of exiting. */
export async function parse(register: (program: Command) => unknown, ...argv: string[]): Promise<void> {
  const program = new Command('aivi').exitOverride();
  await register(program);
  await program.parseAsync(argv, { from: 'user' });
}

/** An empty directory under the temp directory, removed when the test ends. */
export async function scratchDir(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A terminal attached to stdin, or none, until the test ends. */
export function terminal(t: TestContext, attached: boolean): void {
  const before = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: attached, configurable: true });
  t.after(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: before, configurable: true });
  });
}

/** The process exit code as it is now, given back when the test ends: a
 *  command that fails sets it, and the runner must not inherit that. */
export function keepExitCode(t: TestContext): void {
  const before = process.exitCode;
  t.after(() => {
    process.exitCode = before;
  });
}
