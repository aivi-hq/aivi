import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { RequestLogEntry } from '@aivi/core';
import type { Store } from '../src/module.ts';
import type { PluginSetupContext } from '../src/setup.ts';

export const cancelSetup = Symbol('cancel setup');

/** Direct calls only: scripted answers and recorded I/O, never a terminal,
 *  database, filesystem writer or network connection. */
export function setupFixture(t: TestContext, answers: unknown[] = []) {
  let next = 0;
  const questions: Array<{
    message: string;
    validate?: (value: string | undefined) => string | undefined;
    options?: { value: string; label: string }[];
  }> = [];
  const ask = t.mock.fn(async (question: (typeof questions)[number]) => {
    questions.push(question);
    assert.ok(next < answers.length, `Unscripted question: ${question.message}`);
    return answers[next++];
  });
  const note = t.mock.fn();
  const log = t.mock.fn(async (_line: string) => {});
  const print = t.mock.fn<PluginSetupContext['print']>();
  const fetch = t.mock.fn<PluginSetupContext['fetch']>(async url => {
    throw new Error(`Unscripted fetch: ${url}`);
  });
  const configWrites = t.mock.fn<PluginSetupContext['writeConfigBlock']>(async () => {});
  const secretWrites = t.mock.fn<PluginSetupContext['writeSecret']>(async () => {});
  const withStore = t.mock.fn<PluginSetupContext['withStore']>(async () => {
    throw new Error('No store was supplied to this unit test');
  });
  const spinner = () => ({
    start: t.mock.fn<(line: string) => void>(),
    message: t.mock.fn<(line: string) => void>(),
    stop: t.mock.fn<(line: string) => void>(),
    cancel: t.mock.fn<(line: string) => void>(),
  });
  const spinners: ReturnType<typeof spinner>[] = [];
  const prompts = {
    text: ask,
    password: ask,
    select: ask,
    isCancel: (value: unknown) => value === cancelSetup,
    note,
    log: { message: log },
    spinner: () => {
      const progress = spinner();
      spinners.push(progress);
      return progress;
    },
  } as unknown as PluginSetupContext['prompts'];
  const ctx: PluginSetupContext = {
    home: '/aivi',
    configPath: '/aivi/config.json',
    identityName: 'aivi',
    config: { version: 1 },
    prompts,
    print,
    fetch,
    withStore,
    writeConfigBlock: configWrites,
    writeSecret: secretWrites,
  };
  return { ctx, questions, ask, note, log, print, fetch, configWrites, secretWrites, withStore, spinners };
}

/** The diary's read contract, backed by an array rather than SQLite. */
export function setupDiary(t: TestContext) {
  const rows: RequestLogEntry[] = [];
  const read = (filter: Parameters<Store['requests']>[0] = {}) =>
    rows
      .filter(
        row =>
          row.id > (filter.sinceId ?? 0) &&
          (filter.method === undefined || row.method === filter.method) &&
          (filter.path === undefined || row.path === filter.path),
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, filter.limit ?? 500);
  const requests = t.mock.fn(read);
  return { rows, read, requests, store: { requests } as unknown as Store };
}
