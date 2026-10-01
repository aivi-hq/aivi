import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { nextOccurrence } from '../src/clock.ts';
import {
  composeConfigSchema,
  configSchema,
  gitIdentity,
  hostUrl,
  jobSchema,
  loadConfig,
  printedBaseUrl,
  projectsSyncJob,
  retentionJob,
  selectSources,
  systemJobs,
  taskLabel,
  taskSchema,
  userTaskSchema,
} from '../src/config.ts';

test('plugins is an open record in the core schema: blocks pass through as written', () => {
  const block = { connection: { mode: 'launch', userDataDir: 'state/chrome' } };
  const parsed = configSchema.parse({ version: 1, plugins: { browser: block, 'cool-thing': { any: true } } });
  assert.deepEqual(parsed.plugins.browser, block, 'the block is kept as written: its plugin validates it');
  assert.equal(
    configSchema.safeParse({ version: 1, plugins: { 'Bad Id': {} } }).success,
    false,
    'block keys are module ids',
  );
});

test('composeConfigSchema closes the plugins record to the registered plugins', () => {
  const composed = composeConfigSchema({
    alpha: z.strictObject({ resource: z.string().default('local-model'), name: z.string().default('a') }),
  });
  assert.equal(composed.safeParse({ version: 1 }).success, true);
  const parsed = composed.parse({ version: 1, plugins: { alpha: {} } });
  assert.deepEqual(parsed.plugins.alpha, { resource: 'local-model', name: 'a' }, 'the plugin schema fills defaults');
  assert.equal(
    composed.safeParse({ version: 1, plugins: { beta: {} } }).success,
    false,
    'a block for an unregistered plugin fails: configured, not registered',
  );
  assert.equal(composed.safeParse({ version: 1, unexpected: true }).success, false, 'core fields stay strict');
  assert.match(
    JSON.stringify(composed.safeParse({ version: 1, plugins: { alpha: { resource: 'nope' } } }).error?.issues),
    /Unknown resource pool; name one of scheduler\.resources or remove the plugins\.alpha block/,
  );
});

test('plugins contribute project sections: projects close like the plugins record does', () => {
  const composed = composeConfigSchema(
    { alpha: z.strictObject({ name: z.string().default('a') }) },
    {
      alpha: {
        project: z.strictObject({ widget: z.string().default('w') }),
        defaults: z.strictObject({ gadget: z.number().default(7) }),
      },
    },
  );
  const parsed = composed.parse({ version: 1, projects: { site: { alpha: {} } }, projectDefaults: { alpha: {} } });
  // Core cannot type what it does not know: the plugin reads its own sections
  // back with a cast — the `plugins.<id>` pattern, one level down.
  const site = parsed.projects.site as { enabled: boolean; alpha?: { widget: string } };
  assert.deepEqual(
    site,
    { enabled: true, alpha: { widget: 'w' } },
    'the contributed schema fills the project section defaults',
  );
  const defaults = parsed.projectDefaults as { alpha?: { gadget: number } };
  assert.deepEqual(defaults.alpha, { gadget: 7 }, 'and the projectDefaults section alike');
  assert.equal(composed.safeParse({ version: 1 }).success, true, 'sections are optional: nothing written parses');
  assert.equal(
    composed.safeParse({ version: 1, projects: { site: { beta: {} } } }).success,
    false,
    'a project section no registered plugin contributes is an unrecognized key',
  );
  assert.equal(
    composed.safeParse({ version: 1, projectDefaults: { alpha: { gadget: 'seven' } } }).success,
    false,
    'the contributed schema validates the defaults section too',
  );
});

test('config rejects invalid job resources and timezones and unknown fields', () => {
  assert.equal(
    configSchema.safeParse({
      version: 1,
      jobs: [
        {
          id: 'check',
          cron: '* * * * *',
          resource: 'missing',
          task: { kind: 'invocation', name: 'system.check' },
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      version: 1,
      jobs: [
        {
          id: 'check',
          cron: '* * * * *',
          timezone: 'Mars/Olympus',
          task: { kind: 'invocation', name: 'system.check' },
        },
      ],
    }).success,
    false,
  );
  // The open core schema passes unknown fields through untouched: plugins are
  // unknown to core by design, and the composed schema is the gate that
  // refuses them (asserted above, where a registered plugin stands).
  assert.equal(configSchema.safeParse({ version: 1, unexpected: true }).success, true);
});

test('a job is recurring (cron) or one-off (at), never both or neither; misfire is one grace knob', () => {
  const check = { kind: 'invocation', name: 'system.check' } as const;
  assert.equal(jobSchema.safeParse({ id: 'x', task: check }).success, false);
  assert.equal(
    jobSchema.safeParse({ id: 'x', cron: '* * * * *', at: '2026-09-16T09:00:00Z', task: check }).success,
    false,
  );
  assert.equal(jobSchema.safeParse({ id: 'x', at: 'tomorrow', task: check }).success, false);
  const once = jobSchema.parse({ id: 'x', at: '2026-09-16T09:00:00+02:00', task: check, misfire: { graceSeconds: 0 } });
  assert.equal(once.timezone, 'UTC');
  assert.equal(once.misfire?.graceSeconds, 0);
  assert.equal(
    jobSchema.safeParse({ id: 'x', cron: '* * * * *', task: check, misfire: { skipAfterMs: 1 } }).success,
    false,
  );
  const scheduler = configSchema.parse({ version: 1 }).scheduler;
  assert.deepEqual(scheduler.misfire, { graceSeconds: 60 });
  assert.deepEqual(scheduler.retention, { cron: '0 4 * * *', olderThanDays: 30 });
});

test('retention is a system job derived from config: default pool, host timezone, reserved id, off with false', () => {
  const job = retentionJob(configSchema.parse({ version: 1 }), 'Europe/Amsterdam')!;
  assert.deepEqual(
    [job.id, job.cron, job.timezone, job.resource, job.task],
    [
      'retention',
      '0 4 * * *',
      'Europe/Amsterdam',
      'local-model',
      { kind: 'invocation', name: 'runs.prune', args: { olderThanDays: 30 } },
    ],
  );
  const custom = configSchema.parse({
    version: 1,
    scheduler: { resources: { gpu: 1 }, agentSchedules: false, retention: { timezone: 'UTC', olderThanDays: 7 } },
  });
  assert.equal(retentionJob(custom, 'Europe/Amsterdam')!.resource, 'gpu', 'the first pool when local-model is absent');
  assert.equal(retentionJob(custom, 'Europe/Amsterdam')!.timezone, 'UTC');
  assert.equal(retentionJob(configSchema.parse({ version: 1, scheduler: { retention: false } })), null);
  assert.match(
    JSON.stringify(
      configSchema.safeParse({ version: 1, scheduler: { retention: { resource: 'nope' } } }).error?.issues,
    ),
    /set retention to false/,
  );
  assert.match(
    JSON.stringify(
      configSchema.safeParse({
        version: 1,
        jobs: [{ id: 'retention', cron: '* * * * *', task: { kind: 'invocation', name: 'system.check' } }],
      }).error?.issues,
    ),
    /Reserved for the system retention job/,
  );
  assert.equal(
    configSchema.safeParse({
      version: 1,
      scheduler: { retention: false },
      jobs: [{ id: 'retention', cron: '* * * * *', task: { kind: 'invocation', name: 'system.check' } }],
    }).success,
    true,
  );
});

test('projects-sync is a system job too: hourly by default, same pool rule, reserved id, off with false', () => {
  const job = projectsSyncJob(configSchema.parse({ version: 1 }), 'UTC')!;
  assert.deepEqual(
    [job.id, job.cron, job.timezone, job.resource, job.task],
    ['projects-sync', '0 * * * *', 'UTC', 'local-model', { kind: 'invocation', name: 'projects.sync' }],
  );
  assert.deepEqual(
    systemJobs(configSchema.parse({ version: 1, scheduler: { retention: false } }), 'UTC').map(j => j.id),
    ['projects-sync'],
  );
  assert.equal(projectsSyncJob(configSchema.parse({ version: 1, scheduler: { projectsSync: false } })), null);
  assert.match(
    JSON.stringify(
      configSchema.safeParse({ version: 1, scheduler: { projectsSync: { resource: 'nope' } } }).error?.issues,
    ),
    /set projectsSync to false/,
  );
  assert.match(
    JSON.stringify(
      configSchema.safeParse({
        version: 1,
        jobs: [{ id: 'projects-sync', cron: '* * * * *', task: { kind: 'invocation', name: 'system.check' } }],
      }).error?.issues,
    ),
    /Reserved for the system projects-sync job/,
  );
});

test('projects are the directories of <home>/projects; config.json only overrides; selection never falls back on an unknown project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects/website/source'), { recursive: true });
  await mkdir(join(root, 'projects/wiki/source'), { recursive: true });
  await mkdir(join(root, 'projects/paused/source'), { recursive: true });
  await mkdir(join(root, 'projects/.hidden'), { recursive: true });
  await writeFile(join(root, 'projects/README.md'), 'files are not projects');
  await mkdir(join(root, 'projects/gone/memory'), { recursive: true });
  await writeFile(join(root, 'projects/gone/memory/facts.md'), '# Facts: gone');
  await mkdir(join(root, 'memory/proposals'), { recursive: true });
  const write = (projects: Record<string, unknown>) =>
    writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        knowledge: [{ id: 'company', path: 'handbook' }],
        projects,
        linear: { apps: { worker: {} } },
      }),
    );
  await write({
    website: {
      linear: { workspaceId: 'team', teams: ['lt-1'], lanes: { Development: 'worker', Review: 'worker' } },
    },
    wiki: { knowledge: [{ id: 'pages', path: 'pages' }] },
    paused: { enabled: false },
  });
  const loaded = await loadConfig(join(root, 'config.json'));
  assert.equal(loaded.config.stateDirectory, join(root, 'state'));
  assert.deepEqual(
    loaded.projects.map(p => [p.id, p.removed ?? false]),
    [
      ['gone', true],
      ['website', false],
      ['wiki', false],
    ],
    'discovered and sorted; disabled, hidden and plain files left out; a project with memory/ but no source/ is removed',
  );
  assert.deepEqual(
    selectSources(loaded, ['gone'], false).map(s => [s.id, s.path]),
    [['memory', join(root, 'projects/gone/memory')]],
    'a removed project keeps only its memory',
  );
  assert.equal(loaded.projects[1]!.directory, join(root, 'projects/website/source'));
  // (the `linear` section is a plugin's own: core passes it through unread; the
  //  lane merge and team checks live in @aivi/tracker-linear and are tested there)
  // The convention (docs as doc, docs/adr as decision) plus the project's memory, or the project's own list plus memory.
  assert.deepEqual(
    selectSources(loaded, ['website'], false).map(s => [s.id, s.kind, s.path]),
    [
      ['docs', 'doc', join(root, 'projects/website/source/docs')],
      ['adr', 'decision', join(root, 'projects/website/source/docs/adr')],
      ['memory', 'memory', join(root, 'projects/website/memory')],
    ],
  );
  assert.deepEqual(
    selectSources(loaded, ['wiki'], false).map(s => [s.id, s.path]),
    [
      ['pages', join(root, 'projects/wiki/source/pages')],
      ['memory', join(root, 'projects/wiki/memory')],
    ],
  );
  // Core is the configured sources plus the org memory.
  assert.deepEqual(
    selectSources(loaded, [], true).map(s => [s.id, s.path]),
    [
      ['company', join(root, 'handbook')],
      ['memory', join(root, 'memory')],
    ],
  );
  assert.equal(selectSources(loaded, ['website'], false)[0]!.projectId, 'website');
  assert.throws(() => selectSources(loaded, ['typo']), /Unknown project/);
  // An override for a project that is not checked out is a mistake; a directory that is not a valid id must be renamed.
  await write({ missing: {} });
  await assert.rejects(loadConfig(join(root, 'config.json')), /Project missing: nothing at/);
  await write({});
  await mkdir(join(root, 'projects/Bad Name'));
  await assert.rejects(loadConfig(join(root, 'config.json')), /must be named like/);
  await rm(join(root, 'projects/Bad Name'), { recursive: true });
  // A repository cloned straight into projects/<id> is told where it belongs; an empty directory is not a project.
  await mkdir(join(root, 'projects/flat/.git'), { recursive: true });
  await assert.rejects(loadConfig(join(root, 'config.json')), /holds its checkout in source\//);
  await rm(join(root, 'projects/flat'), { recursive: true });
  await mkdir(join(root, 'projects/empty'));
  await assert.rejects(loadConfig(join(root, 'config.json')), /not a project/);
  await rm(join(root, 'projects/empty'), { recursive: true });
  // The id `memory` is reserved for aivi's own sources.
  assert.equal(
    configSchema.safeParse({ version: 1, knowledge: [{ id: 'memory', path: 'memory', kind: 'memory' }] }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ version: 1, projects: { a: { knowledge: [{ id: 'memory', path: 'm' }] } } }).success,
    false,
  );
  assert.equal(configSchema.safeParse({ version: 1, projects: { 'Bad Id': {} } }).success, false);
});

test('core passes a plugin project section through unread and unwidened', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-lanes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const linearSection = { teams: ['t-1'], lanes: { Review: { agent: 'reviewer', worktree: false }, Shipped: null } };
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      projectDefaults: { linear: { lanes: { Dev: 'dev' }, workspaceId: 'ws-default' } },
      projects: { site: { linear: linearSection } },
    }),
  );
  const loaded = await loadConfig(join(root, 'config.json'));
  // The section is present in the raw config exactly as written — core parsed it
  // with the open catchall and read nothing inside — and the plugin's own schema
  // (its merge, its human-lane drop) is what turns it into routing, tested in
  // @aivi/tracker-linear. The core Project view carries no `linear`.
  assert.deepEqual((loaded.config.projects.site as unknown as { linear: unknown }).linear, linearSection);
  assert.equal('linear' in loaded.projects[0]!, false, 'core hands the project view without a plugin section');
});

test('dispatcher config: no pools means unlimited, timeouts default, fallback chains load-check', () => {
  const plain = configSchema.parse({ version: 1 });
  assert.equal(plain.dispatcher.pools, undefined, 'no pools block: capacity is not moderated');
  assert.deepEqual(plain.dispatcher.timeouts, { idle: '180m', prepare: '5m' });
  assert.equal(plain.orchestrator.elicitationKeepAlive, '5m', 'the orchestrator’s own dial, at the root');

  const pools = { default: { capacity: 2 }, worker: { model: 'a/b', capacity: 2, fallback: 'default' } };
  const ok = configSchema.safeParse({
    version: 1,
    dispatcher: { pools, timeouts: { idle: '1h 30m' } },
    orchestrator: { elicitationKeepAlive: '10m' },
  });
  assert.equal(ok.success, true, 'durations add by spaces: 1h 30m parses');

  const missing = configSchema.safeParse({ version: 1, dispatcher: { pools: { a: { capacity: 1, fallback: 'b' } } } });
  assert.equal(missing.success, false);
  assert.match(JSON.stringify(missing.error?.issues), /falls back to .*b.* which is not a configured pool/);

  const cycle = configSchema.safeParse({
    version: 1,
    dispatcher: { pools: { a: { capacity: 1, fallback: 'b' }, b: { capacity: 1, fallback: 'a' } } },
  });
  assert.equal(cycle.success, false, 'fallback chains must end');
  assert.match(JSON.stringify(cycle.error?.issues), /cycles through/);

  const bogus = configSchema.safeParse({ version: 1, dispatcher: { timeouts: { idle: '90' } } });
  assert.match(JSON.stringify(bogus.error?.issues), /Not a duration/);
});

test('lane arrays load-validate: unique names, real next/previous targets, and one queue feeding a worker', () => {
  const lanes = (written: unknown[]) => configSchema.safeParse({ version: 1, projects: { site: { lanes: written } } });
  assert.equal(
    lanes([
      { name: 'Todo', agent: 'dev', pool: 'worker' },
      { name: 'Review', agent: 'dev' },
    ]).success,
    true,
    'queue and pool are optional; a named pool loads inert until the dispatcher is built',
  );
  assert.equal(
    lanes([
      { name: 'Todo', agent: 'dev' },
      { name: 'Todo', agent: 'dev' },
    ]).success,
    false,
  );
  assert.match(JSON.stringify(lanes([{ name: 'Todo', agent: 'dev', next: 'Gone' }]).error?.issues), /not a lane/);
  // The queue lane's rules (docs/orchestrator.md): at most one per workflow,
  // never worked by an agent of its own, and its next lane — by override or
  // by order — is a worker lane. All loud, all at load.
  assert.equal(
    lanes([
      { name: 'Todo', queue: true },
      { name: 'In Progress', agent: 'dev' },
    ]).success,
    true,
  );
  assert.match(
    JSON.stringify(
      lanes([
        { name: 'Todo', queue: true, agent: 'dev' },
        { name: 'Doing', agent: 'dev' },
      ]).error?.issues,
    ),
    /holds work, it works none/,
  );
  assert.match(
    JSON.stringify(
      lanes([
        { name: 'A', queue: true },
        { name: 'B', queue: true },
        { name: 'C', agent: 'dev' },
      ]).error?.issues,
    ),
    /at most one queue lane/,
  );
  assert.match(JSON.stringify(lanes([{ name: 'Todo', queue: true }]).error?.issues), /has no next lane/);
  assert.match(
    JSON.stringify(lanes([{ name: 'Todo', queue: true }, { name: 'Review' }]).error?.issues),
    /no agent works/,
  );
  assert.match(
    JSON.stringify(
      lanes([{ name: 'Todo', queue: true, next: 'Review' }, { name: 'In Progress', agent: 'dev' }, { name: 'Review' }])
        .error?.issues,
    ),
    /no agent works/,
    'the next override is held to the same rule as plain order',
  );
});

test('calendar calculations use the configured timezone across daylight saving changes', () => {
  const pattern = '0 9 * * *';
  assert.equal(
    new Date(nextOccurrence(pattern, 'Europe/Amsterdam', Date.parse('2026-03-28T00:00:00Z'))).toISOString(),
    '2026-03-28T08:00:00.000Z',
  );
  assert.equal(
    new Date(nextOccurrence(pattern, 'Europe/Amsterdam', Date.parse('2026-03-29T00:00:00Z'))).toISOString(),
    '2026-03-29T07:00:00.000Z',
  );
});

test('agent scheduling is on by default in local-model, can be disabled, and must name an existing pool', () => {
  assert.deepEqual(configSchema.parse({ version: 1 }).scheduler.agentSchedules, { resource: 'local-model', max: 50 });
  assert.equal(
    configSchema.parse({ version: 1, scheduler: { agentSchedules: false } }).scheduler.agentSchedules,
    false,
  );
  const custom = configSchema.safeParse({ version: 1, scheduler: { resources: { gpu: 1 } } });
  assert.equal(custom.success, false, 'default pool local-model does not exist here');
  assert.match(JSON.stringify(custom.error?.issues), /set agentSchedules to false/);
  assert.deepEqual(
    configSchema.parse({ version: 1, scheduler: { resources: { gpu: 1 }, agentSchedules: { resource: 'gpu' } } })
      .scheduler.agentSchedules,
    { resource: 'gpu', max: 50 },
  );
});

test('tasks are prompt, shell or invocation; only prompt and shell are tasks anyone can author', () => {
  assert.equal(taskSchema.safeParse({ kind: 'prompt', agent: 'a', directory: '/d', prompt: 'p' }).success, true);
  assert.equal(
    taskSchema.safeParse({ kind: 'opencode.prompt', agent: 'a', directory: '/d', prompt: 'p' }).success,
    false,
  );
  assert.equal(taskSchema.safeParse({ kind: 'invocation', name: 'linear.sweep' }).success, true);
  assert.equal(taskSchema.safeParse({ kind: 'invocation', name: 'linear.sweep', args: { days: 7 } }).success, true);
  assert.equal(taskSchema.safeParse({ kind: 'invocation' }).success, false, 'name is required');
  assert.equal(taskSchema.safeParse({ kind: 'dreaming' }).success, false, 'dreaming is an operation, not a kind');
  // What aivi_jobs and a task file accept: no invocations, so an agent cannot schedule host capabilities.
  assert.equal(userTaskSchema.safeParse({ kind: 'shell', command: ['ls'] }).success, true);
  assert.equal(userTaskSchema.safeParse({ kind: 'prompt', agent: 'a', directory: '/d', prompt: 'p' }).success, true);
  assert.equal(userTaskSchema.safeParse({ kind: 'invocation', name: 'dreaming' }).success, false);
  // Views show what a job actually does: the operation name, not the word "invocation".
  assert.equal(taskLabel(taskSchema.parse({ kind: 'invocation', name: 'dreaming', args: {} })), 'dreaming');
  assert.equal(taskLabel(taskSchema.parse({ kind: 'shell', command: ['ls'] })), 'shell');
});

test('a hand-written job may name its operation as a bare string', () => {
  const job = jobSchema.parse({ id: 'check', cron: '* * * * *', task: 'system.check' });
  assert.deepEqual(job.task, { kind: 'invocation', name: 'system.check' });
  // Explicit shape still wins, and carries args the string cannot.
  const explicit = jobSchema.parse({
    id: 'dream',
    cron: '* * * * *',
    task: { kind: 'invocation', name: 'dreaming', args: { origins: ['discord'] } },
  });
  assert.equal(explicit.task.kind, 'invocation');
  assert.deepEqual(explicit.task.args, { origins: ['discord'] });
});

test('scheduler.timezone is the host-wide default; a per-job timezone wins over it', () => {
  const config = configSchema.parse({ version: 1, scheduler: { timezone: 'Europe/Amsterdam' } });
  const job = retentionJob(config, 'UTC');
  assert.equal(job!.timezone, 'Europe/Amsterdam');
  const override = configSchema.parse({
    version: 1,
    scheduler: { timezone: 'Europe/Amsterdam', retention: { timezone: 'Pacific/Auckland' } },
  });
  assert.equal(retentionJob(override, 'UTC')!.timezone, 'Pacific/Auckland');
  // Without the setting, derived schedules keep the host timezone.
  assert.equal(retentionJob(configSchema.parse({ version: 1 }), 'UTC')!.timezone, 'UTC');
});

test('identity is the persona, and who a worker commits as comes from the file, the machine, then the app', async () => {
  const bare = configSchema.parse({ version: 1 });
  assert.equal(bare.identity.name, 'aivi', 'the persona has a default');
  assert.equal(
    configSchema.parse({ version: 1, identity: { name: 'Clawd The' } }).identity.name,
    'Clawd The',
    'the display name stays free-form; the assistant agent name is the Linear plugin’s own',
  );
  const app = { name: 'aivi-agent[bot]', email: '331678708+aivi-agent[bot]@users.noreply.github.com' };
  const machine = async (key: string) => (key === 'opencode.coauthor' ? 'Jane Doe <jane@example.com>' : '');
  assert.deepEqual(
    await gitIdentity(bare.identity, machine),
    { name: 'Jane Doe', email: 'jane@example.com' },
    'the machine answers while the file is silent',
  );
  const written = configSchema.parse({
    version: 1,
    identity: { github: { user: 'worker[bot]', email: '99+worker[bot]@users.noreply.github.com' } },
  });
  assert.deepEqual(
    await gitIdentity(written.identity, machine),
    { name: 'worker[bot]', email: '99+worker[bot]@users.noreply.github.com' },
    'the file wins over the machine',
  );
  assert.deepEqual(await gitIdentity(bare.identity, async () => ''), app, 'the app is the last resort');
  assert.deepEqual(
    await gitIdentity(bare.identity, async () => {
      throw new Error('no git here');
    }),
    app,
    'an unreadable machine still gets the app',
  );
  assert.deepEqual(
    await gitIdentity(bare.identity, async () => 'Jane Doe'),
    app,
    'a value that is not `Name <email>` names no author: nobody is attributed by mistake',
  );
  assert.match(
    JSON.stringify(configSchema.safeParse({ version: 1, identity: { github: { user: 'worker[bot]' } } }).error?.issues),
    /Name the pair/,
    'a name without an email would mix a bot author with a human address',
  );
});

test('host.public: the reach address, validated and preferred when printed', () => {
  const host = configSchema.parse({ version: 1 }).host;
  assert.equal(host.public, undefined, 'unset by default: asked, never guessed');
  assert.equal(hostUrl(host), 'http://127.0.0.1:4100', 'a wildcard-free loopback bind');
  assert.equal(hostUrl({ bind: '0.0.0.0', port: 8080 }), 'http://127.0.0.1:8080', 'a wildcard bind collapses');
  const base = 'https://you.tailscale.ts.net/aivi';
  assert.equal(configSchema.parse({ version: 1, host: { public: base } }).host.public, base, 'a path is allowed');
  for (const bad of ['https://a.test/', 'ftp://a.test', 'a.test', 'https://a.test/sub/']) {
    assert.equal(
      configSchema.safeParse({ version: 1, host: { public: bad } }).success,
      false,
      `${bad} is not a valid public base`,
    );
  }
  const declared = configSchema.parse({ version: 1, host: { public: base } });
  assert.deepEqual(printedBaseUrl(declared), { url: base, declared: true });
  assert.deepEqual(printedBaseUrl(configSchema.parse({ version: 1 })), {
    url: 'http://127.0.0.1:4100',
    declared: false,
  });
});
