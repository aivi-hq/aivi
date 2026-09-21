import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextOccurrence } from '../src/clock.ts';
import {
  assistantAgent,
  configSchema,
  gitIdentity,
  jobSchema,
  linearSecretNames,
  loadConfig,
  projectsSyncJob,
  retentionJob,
  selectSources,
  systemJobs,
  taskLabel,
  taskSchema,
  userTaskSchema,
} from '../src/config.ts';

test('linear settings: defaults, secret names, reserved pool', () => {
  const linear = configSchema.parse({ version: 1, linear: { apps: { dev: {} } } }).linear!;
  assert.deepEqual(
    [linear.listener, linear.humanLabel, linear.resource, linear.progress, linear.turnTimeoutMs, linear.logMisroutes],
    [false, 'needs-human', 'local-model', 'tools', 7_200_000, true],
  );
  assert.deepEqual(linear.mcp, { port: 4101 }, 'the Linear MCP is on by default on its loopback port');
  assert.deepEqual(configSchema.parse({ version: 1, linear: { apps: { dev: {} }, mcp: false } }).linear!.mcp, false);
  assert.deepEqual(linearSecretNames('dev-app'), {
    clientId: 'LINEAR_DEV_APP_CLIENT_ID',
    clientSecret: 'LINEAR_DEV_APP_CLIENT_SECRET',
    webhookSecret: 'LINEAR_DEV_APP_WEBHOOK_SECRET',
  });
  assert.ok(
    configSchema.safeParse({ version: 1, linear: { apps: { data: {} } } }).success,
    'no app id is reserved: the bare LINEAR_* names mean the primary',
  );
  assert.match(
    JSON.stringify(configSchema.safeParse({ version: 1, linear: { apps: {}, resource: 'gpu' } }).error?.issues),
    /Unknown resource pool/,
  );
  assert.match(
    JSON.stringify(
      configSchema.safeParse({
        version: 1,
        linear: { apps: { dev: {} } },
        projects: {
          website: { linear: { teams: ['lt-1'], lanes: {} } },
          api: { linear: { teams: ['lt-1', 'lt-2'], lanes: {} } },
        },
      }).error?.issues,
    ),
    /already mapped to project website/,
  );
});

test('channel modules are blocks in the one file: presence enables with defaults, false is off, the pool must exist', () => {
  const on = configSchema.parse({
    version: 1,
    modules: {
      discord: { applicationId: '10000000000000001', access: {} },
      slack: { access: {} },
    },
  });
  if (typeof on.modules.discord !== 'object' || typeof on.modules.slack !== 'object')
    throw new Error('present blocks parse to settings, not false');
  assert.equal(on.modules.discord.agent, 'librarian');
  assert.equal(on.modules.slack.commandPrefix, 'aivi');
  assert.deepEqual(configSchema.parse({ version: 1, modules: { discord: false } }).modules, { discord: false });
  assert.match(
    JSON.stringify(
      configSchema.safeParse({
        version: 1,
        modules: { discord: { applicationId: '10000000000000001', access: {}, resource: 'nope' } },
      }).error?.issues,
    ),
    /Unknown resource pool; name one of scheduler\.resources or set modules\.discord to false/,
  );
});

test('a modules.*.config pointer is the old shape and says where the settings went', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-inline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ version: 1, modules: { discord: { config: 'discord.json' } } }),
  );
  await assert.rejects(loadConfig(join(root, 'config.json')), /the discord settings live inline/);
});

test('config rejects ambiguous Linear primary settings and invalid job resources', () => {
  // Several apps without a primary: which one carries the data feed is ambiguous.
  assert.equal(
    configSchema.safeParse({
      version: 1,
      linear: { apps: { developer: {}, reviewer: {} } },
    }).success,
    false,
  );
  // A primary that is not a configured app is a typo.
  assert.equal(
    configSchema.safeParse({
      version: 1,
      linear: { primary: 'ghost', apps: { developer: {}, reviewer: {} } },
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      version: 1,
      linear: { primary: 'developer', apps: { developer: {}, reviewer: {} } },
    }).success,
    true,
  );
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
  assert.equal(configSchema.safeParse({ version: 1, unexpected: true }).success, false);
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
  assert.equal(loaded.projects[1]!.linear!.lanes.Review!.agent, 'worker');
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

test('projectDefaults.linear.lanes is the base; a project wins one lane at a time, and null means humans work it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-lanes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects/site/source'), { recursive: true });
  const write = (extra: Record<string, unknown>) =>
    writeFile(
      join(root, 'config.json'),
      JSON.stringify({ version: 1, linear: { primary: 'dev', apps: { dev: {}, review: {} } }, ...extra }),
    );
  await write({
    projectDefaults: { linear: { lanes: { Dev: 'dev', Review: 'dev', Triage: null }, workspaceId: 'ws-default' } },
    projects: {
      site: { linear: { teams: ['t-1'], lanes: { Review: { agent: 'reviewer', worktree: false }, Shipped: null } } },
    },
  });
  const routing = (await loadConfig(join(root, 'config.json'))).projects[0]!.linear!;
  assert.deepEqual(
    routing.lanes,
    { Dev: { agent: 'dev', worktree: true }, Review: { agent: 'reviewer', worktree: false } },
    'the convention is the base, the entry wins per lane, and human lanes are absent from the map the listener consults',
  );
  assert.equal(routing.workspaceId, 'ws-default', 'workspaceId falls back to the convention');
  const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(raw.projects.site.linear.lanes.Shipped, null, 'the file keeps the human lanes');

  // A bare linear entry gets the whole convention, workspaceId included.
  await write({
    projectDefaults: { linear: { lanes: { Dev: 'dev' }, workspaceId: 'ws-default' } },
    projects: { site: { linear: { teams: ['t-1'] } } },
  });
  const bare = (await loadConfig(join(root, 'config.json'))).projects[0]!.linear!;
  assert.deepEqual(
    bare.lanes,
    { Dev: { agent: 'dev', worktree: true } },
    'the convention applies untouched when the project maps nothing',
  );
  assert.equal(bare.workspaceId, 'ws-default');

  // A lane names an OpenCode agent; no app resolution happens at load time — an
  // unknown agent file is OpenCode's own error at session start.
  await write({
    projectDefaults: { linear: { lanes: { Dev: 'ghost-agent' } } },
    projects: { site: { linear: { teams: ['t-1'] } } },
  });
  const ghosted = (await loadConfig(join(root, 'config.json'))).projects[0]!.linear!;
  assert.deepEqual(ghosted.lanes, { Dev: { agent: 'ghost-agent', worktree: true } });
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
  assert.equal(assistantAgent(bare), 'aivi', 'the Linear assistant takes the persona name');
  assert.equal(
    assistantAgent(configSchema.parse({ version: 1, identity: { name: 'Clawd The' } })),
    'clawd-the',
    'the agent name is the persona slugged, while the display name stays free-form',
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

test('a top-level name is the old shape and says where the persona went', async t => {
  const root = await mkdtemp(join(tmpdir(), 'aivi-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, name: 'aivi' }));
  await assert.rejects(loadConfig(join(root, 'config.json')), /identity\.name/);
});
