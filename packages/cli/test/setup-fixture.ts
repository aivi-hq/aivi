import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { saveClientConfig } from '../src/client-config.ts';
import { createSetupIo, type SetupIo } from '../src/setup.ts';

export const TOKEN = `aivi-${'a'.repeat(32)}`;
export const hostUrl = 'http://127.0.0.1:4100';
export const modelDefaults = { embed: 'embed-default', rerank: 'rerank-default', generate: 'generate-default' };

function setupTty(t: TestContext, tty: boolean): void {
  const before = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  t.after(() => {
    if (before) Object.defineProperty(process.stdin, 'isTTY', before);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
  });
}

const unasked =
  <T>(name: string) =>
  async (): Promise<T> => {
    throw new Error(`Unexpected setup question: ${name}`);
  };

/** Setup's filesystem boundary is a scratch home. Every process, HTTP,
 *  service, prompt and model call is a recorded in-process fake. */
export function setupFixture(t: TestContext, tty = false) {
  const directory = mkdtempSync(join(tmpdir(), 'aivi-setup-test-'));
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  const configPath = join(home, 'config.json');
  const clientPath = join(directory, 'client.json');
  t.mock.property(process, 'env', { ...process.env, AIVI_CONFIG: clientPath });
  setupTty(t, tty);
  const exitCode = process.exitCode;
  t.after(() => {
    process.exitCode = exitCode;
    rmSync(directory, { recursive: true, force: true });
  });

  const identity = { home, url: hostUrl, person: 'person-1234abcd', name: 'Ada', token: TOKEN };
  const who = { person: { id: identity.person, name: identity.name }, roles: ['operator'] };
  const warmHome = t.mock.fn<Awaited<ReturnType<SetupIo['loadKnowledge']>>['warmHome']>(async () => ({
    models: modelDefaults,
    embedded: 7,
    seconds: 2,
  }));
  const install = t.mock.fn<SetupIo['install']>(() => {});
  const rebuildSchema = t.mock.fn<SetupIo['rebuildSchema']>(async () => {});
  const npmView = t.mock.fn<SetupIo['npmView']>(async () => '9.9.9');
  const createIdentity = t.mock.fn<SetupIo['createIdentity']>(async step => {
    // The installed identity step writes the bearer and URL for this machine;
    // setup's later whoami is what may add the verified display cache.
    if (step.use === 'this-machine') saveClientConfig({ home, url: hostUrl, person: { token: TOKEN } });
    return identity;
  });
  const loadKnowledge = t.mock.fn<SetupIo['loadKnowledge']>(async () => ({
    QMD_BUILTIN_MODELS: modelDefaults,
    warmHome,
  }));
  const opencodeOnPath = t.mock.fn<SetupIo['opencodeOnPath']>(() => true);
  const pluginAdd = t.mock.fn<SetupIo['pluginAdd']>(() => {});
  const health = t.mock.fn<SetupIo['health']>(async () => true);
  const whoami = t.mock.fn<SetupIo['whoami']>(async () => who);
  const serviceInstall = t.mock.fn<SetupIo['serviceInstall']>(() => {});
  const ask = {
    branch: t.mock.fn<SetupIo['ask']['branch']>(unasked('branch')),
    machine: t.mock.fn<SetupIo['ask']['machine']>(unasked('machine')),
    background: t.mock.fn<SetupIo['ask']['background']>(unasked('background')),
    name: t.mock.fn<SetupIo['ask']['name']>(unasked('name')),
    reach: t.mock.fn<SetupIo['ask']['reach']>(unasked('reach')),
    url: t.mock.fn<SetupIo['ask']['url']>(unasked('url')),
    token: t.mock.fn<SetupIo['ask']['token']>(unasked('token')),
    models: t.mock.fn<SetupIo['ask']['models']>(unasked('models')),
    fetchModels: t.mock.fn<SetupIo['ask']['fetchModels']>(unasked('fetchModels')),
    capacity: t.mock.fn<SetupIo['ask']['capacity']>(unasked('capacity')),
  };
  const log = t.mock.fn<SetupIo['log']>();
  const warn = t.mock.fn<SetupIo['warn']>();
  const cancel = t.mock.fn<SetupIo['cancel']>();
  const io: SetupIo = {
    install,
    rebuildSchema,
    npmView,
    createIdentity,
    loadKnowledge,
    opencodeOnPath,
    pluginAdd,
    health,
    whoami,
    serviceInstall,
    ask,
    log,
    warn,
    cancel,
  };
  const config = (value: unknown) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath, JSON.stringify(value));
  };
  const installedModule = (modulePath: string, body: string) => {
    const pkg = join(appDir, 'node_modules', '@aivi', 'host');
    mkdirSync(dirname(join(pkg, modulePath)), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@aivi/host', type: 'module' }));
    writeFileSync(join(pkg, modulePath), body);
    return join(pkg, modulePath);
  };
  return {
    directory,
    home,
    appDir,
    configPath,
    clientPath,
    identity,
    who,
    io,
    install,
    rebuildSchema,
    npmView,
    createIdentity,
    loadKnowledge,
    warmHome,
    opencodeOnPath,
    pluginAdd,
    health,
    whoami,
    serviceInstall,
    ask,
    log,
    warn,
    cancel,
    config,
    installedModule,
  };
}

export const cancelSetup = Symbol('cancel setup');

export function interactiveSetup(t: TestContext) {
  const h = setupFixture(t, true);
  h.ask.branch.mock.mockImplementation(async () => 'create');
  h.ask.machine.mock.mockImplementation(async () => 'this-machine');
  h.ask.name.mock.mockImplementation(async () => 'Ada');
  h.ask.reach.mock.mockImplementation(async () => ({ kind: 'none' }));
  h.ask.models.mock.mockImplementation(async () => ({}));
  h.ask.fetchModels.mock.mockImplementation(async () => false);
  h.ask.capacity.mock.mockImplementation(async () => undefined);
  h.ask.background.mock.mockImplementation(async () => false);
  return h;
}

export function setupPrompts(t: TestContext, answers: unknown[], tty = true) {
  setupTty(t, tty);
  type Question = {
    message: string;
    placeholder?: string;
    initialValue?: boolean;
    options?: { value: string; label: string }[];
    validate?: (value: string | undefined) => string | undefined;
  };
  const questions: Question[] = [];
  let next = 0;
  const ask = t.mock.fn(async (question: Question) => {
    questions.push(question);
    assert.ok(next < answers.length, `Unscripted question: ${question.message}`);
    return answers[next++];
  });
  const cancel = t.mock.fn<(message: string) => void>();
  const prompts = {
    select: ask,
    text: ask,
    confirm: ask,
    isCancel: (answer: unknown) => answer === cancelSetup,
    cancel,
  } as unknown as NonNullable<Parameters<typeof createSetupIo>[0]>;
  return { io: createSetupIo(prompts), questions, ask, cancel };
}

/** Observe the actual wait before advancing time, not the health call that
 *  precedes it. No sleep, polling helper or guessed promise-flush count. */
export function setupClock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-13T10:00:00Z') });
  const scheduled = Promise.withResolvers<number>();
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    const handle = timeout(...args);
    scheduled.resolve(args[1] ?? 0);
    return handle;
  });
  return scheduled.promise;
}
