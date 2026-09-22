/** Jobs and runs: definitions and their executions, straight against the
 *  store, with a poke to the running host after each change. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RunState } from '@aivi/core';
import { jobSchema, parseDue, reportSchema, taskLabel, taskSchema } from '@aivi/core';
import type { Command } from 'commander';
import { z } from 'zod';
import { context, home, print, withStore } from '../context.ts';

export function registerJobs(program: Command): void {
  const jobs = program
    .command('jobs')
    .description('Job definitions: configured, system, agent- and operator-created')
    .helpGroup('Jobs & runs');
  jobs
    .command('list')
    .description('Every definition with its source, state, next occurrence and last run')
    .action(async () => {
      const { loaded } = await context();
      await withStore(loaded, store =>
        print(
          store.jobs().map(j => ({
            id: j.spec.id,
            title: j.spec.title ?? null,
            source: j.source,
            state: j.state,
            when: j.spec.at !== undefined ? `at ${j.spec.at}` : `cron ${j.spec.cron} (${j.spec.timezone})`,
            nextAt: j.nextAt === null ? null : new Date(j.nextAt).toISOString(),
            kind: taskLabel(j.spec.task),
            resource: j.spec.resource,
            lastRun: store.lastRun(j.spec.id)?.state ?? null,
          })),
        ),
      );
    });
  jobs
    .command('show <id>')
    .description('One job with its runs')
    .action(async id => {
      const { loaded } = await context();
      await withStore(loaded, store => print({ job: store.job(id), runs: store.runs({ jobId: id }) }));
    });
  jobs
    .command('add <file>')
    .description('Add a job from a task file: a task, or {task, report?, resource?}')
    .option('--at <when>', 'ISO timestamp or 30m|2h|1d; without --at or --cron it runs once, now')
    .option('--cron <expr>', 'a recurring schedule')
    .option('--timezone <tz>', "IANA timezone for --cron; defaults to this machine's")
    .option('--title <text>', 'a title for the job')
    .option('--resource <pool>', "the resource pool; the task file's resource, else local-model")
    .option('--key <id>', 'deduplicates identical requests')
    .action(async (file, values) => {
      const { loaded, poke } = await context();
      // A task file is either a bare task or { task, report?, resource? }.
      const raw: unknown = JSON.parse(await readFile(resolve(file), 'utf8'));
      const wrapped = jobFileSchema.safeParse(raw);
      const {
        task,
        report,
        resource: fileResource,
      } = wrapped.success ? wrapped.data : { task: taskSchema.parse(raw), report: undefined, resource: undefined };
      // Paths in task files resolve against the home, like paths in config.json.
      // Invocation args belong to the claimant: they resolve when the operation runs.
      if (task.kind === 'prompt') task.directory = resolve(home, task.directory);
      if (task.kind === 'shell' && task.cwd) task.cwd = resolve(home, task.cwd);
      const resource = values.resource ?? fileResource ?? 'local-model';
      if (!(resource in loaded.config.scheduler.resources)) throw new Error(`Unknown resource pool: ${resource}`);
      if (values.at && values.cron) throw new Error('Choose --at (one-off) or --cron (recurring)');
      const now = Date.now();
      const spec = jobSchema.parse({
        id: `job-${randomUUID().slice(0, 8)}`,
        ...(values.title ? { title: values.title } : {}),
        ...(values.cron
          ? { cron: values.cron, timezone: values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }
          : { at: new Date(values.at ? parseDue(values.at, now) : now).toISOString() }),
        resource,
        task,
        ...(report ? { report } : {}),
      });
      await withStore(loaded, async store => {
        const job = store.addJob(spec, 'operator', now, { dedupeKey: `manual:${values.key ?? randomUUID()}` });
        print({ job, runs: store.runs({ jobId: job.spec.id }) });
      });
      await poke();
    });
  jobs
    .command('run <id>')
    .description('Queue one run of this job now, outside its schedule')
    .action(async id => {
      const { loaded, poke } = await context();
      await withStore(loaded, store => print(store.runJob(id)));
      await poke();
    });
  jobs
    .command('pause <id>')
    .description('Pause an agent- or operator-created job')
    .action(async id => {
      const { loaded, poke } = await context();
      await withStore(loaded, store => print(store.setJobEnabled(id, false)));
      await poke();
    });
  jobs
    .command('resume <id>')
    .description('Resume a paused job')
    .action(async id => {
      const { loaded, poke } = await context();
      await withStore(loaded, store => print(store.setJobEnabled(id, true)));
      await poke();
    });
  jobs
    .command('remove <id>')
    .description('Remove an agent- or operator-created job')
    .action(async id => {
      const { loaded } = await context();
      await withStore(loaded, store => {
        store.removeJob(id);
        print({ removed: id });
      });
    });

  const runs = program.command('runs').description('run executions of jobs').helpGroup('Jobs & runs');
  runs
    .command('list')
    .description('Runs (operator output, including prompts)')
    .option('--job <id>', 'only this job')
    .option('--state <state>', 'queued|running|succeeded|failed|blocked|cancelled|missed')
    .option('--limit <n>', 'at most this many runs')
    .action(async values => {
      const { loaded } = await context();
      await withStore(loaded, store =>
        print(
          store.runs({
            ...(values.job ? { jobId: values.job } : {}),
            ...(values.state ? { state: runState(values.state) } : {}),
            ...(values.limit ? { limit: Number(values.limit) } : {}),
          }),
        ),
      );
    });
  runs
    .command('show <id>')
    .description('One run with its audit history')
    .action(async id => {
      const { loaded } = await context();
      await withStore(loaded, store => print({ run: store.run(id), history: store.history(id) }));
    });
  runs
    .command('cancel <id>')
    .description('Cancel a queued run only')
    .action(async id => {
      const { loaded } = await context();
      await withStore(loaded, store => {
        store.cancelQueued(id);
        print(store.run(id));
      });
    });
  runs
    .command('abort <id>')
    .description('Ask the scheduler to stop a running run; it ends blocked for resolve')
    .action(async id => {
      const { loaded, poke } = await context();
      await withStore(loaded, store => {
        store.requestCancel(id);
        print(store.run(id));
      });
      await poke();
    });
  runs
    .command('resolve <id>')
    .description('Release a blocked run after inspection/repair')
    .requiredOption('--outcome <state>', 'succeeded | failed')
    .requiredOption('--reason <text>', 'what was found and done')
    .requiredOption('--confirm-stopped', 'the external side has stopped')
    .action(async (id, values) => {
      if (!['succeeded', 'failed'].includes(values.outcome))
        throw new Error(`--outcome is succeeded or failed, not ${values.outcome}`);
      const { loaded, poke } = await context();
      await withStore(loaded, store => {
        store.resolveBlocked(id, values.outcome as 'succeeded' | 'failed', values.reason);
        print(store.run(id));
      });
      await poke();
    });
}
const RUN_STATES: RunState[] = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'missed'];
function runState(value: string): RunState {
  if (!RUN_STATES.includes(value as RunState))
    throw new Error(`Unknown run state: ${value}. One of ${RUN_STATES.join(', ')}`);
  return value as RunState;
}

const jobFileSchema = z.strictObject({
  task: z.preprocess(value => (typeof value === 'string' ? { kind: 'invocation', name: value } : value), taskSchema),
  report: reportSchema.optional(),
  resource: z.string().min(1).optional(),
});
