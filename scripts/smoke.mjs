import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/app/dist/cli.js', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'aivi-smoke-'));
const config = join(directory, 'config.json');
let daemon;
let stopped;
/** Poll until `probe` returns true; a smoke check waits on the running host, it never assumes timing. */
const until = async (probe, ms = 10000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error('smoke: timed out waiting for the host to execute the run');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
};
try {
  // "discover": a smoke check must never restart the developer's own OpenCode service.
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      host: { port: 0 },
      opencode: { lifecycle: 'discover' },
      knowledge: [{ id: 'demo', path: '.' }],
    }),
  );
  const task = join(directory, 'check.json');
  await writeFile(task, JSON.stringify({ kind: 'invocation', name: 'system.check' }));
  // The temp directory is the aivi home: config.json, .env and state/ live there.
  const env = { ...process.env, AIVI_HOME: directory };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env }));
  assert.equal(run('config', 'check').valid, true);
  const added = run('jobs', 'add', task, '--key', 'smoke', '--title', 'Smoke check');
  assert.equal(added.job.source, 'operator');
  assert.equal(added.runs.length, 1, 'a one-off due now is materialized at once');
  assert.equal(
    run('jobs', 'add', task, '--key', 'smoke', '--title', 'Smoke check').job.spec.id,
    added.job.spec.id,
    'the key deduplicates',
  );

  daemon = spawn(process.execPath, [cli, 'serve'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stopped = once(daemon, 'exit');
  const listening = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host startup timed out')), 10000);
    let buffer = '';
    daemon.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    daemon.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Host exited during startup: ${code}`));
    });
    daemon.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(buffer.split('\n')[0]).listening);
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  // The queued one-off is due now: the serving loop dispatches it on its first pass.
  await until(() =>
    fetch(`http://127.0.0.1:${listening.port}/v1/status`, { signal: AbortSignal.timeout(5000) })
      .then(response => response.json())
      .then(status => status.counts.succeeded === 1),
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${listening.port}/v1/status`, {
        headers: { authorization: 'Bearer aivi-not-a-real-token' },
        signal: AbortSignal.timeout(5000),
      })
    ).status,
    200,
    'an unknown bearer is accepted, anonymous',
  );
  assert.equal((await fetch(`http://127.0.0.1:${listening.port}/health`)).status, 200, 'liveness is public');
  daemon.kill('SIGTERM');
  const [code] = await stopped;
  assert.equal(code, 0);

  // Every CLI read happens after the clean shutdown released singleton ownership: the store reopens,
  // and the run the host executed is durable in SQLite.
  const shown = run('runs', 'show', added.runs[0].id);
  assert.equal(shown.run.state, 'succeeded');
  assert.equal(shown.run.result.sources[0].available, true);
  assert.equal(run('jobs', 'show', added.job.spec.id).job.state, 'done');
  assert.ok(
    run('jobs', 'list').some(j => j.id === 'retention' && j.source === 'system'),
    'the retention job is seeded from scheduler.retention',
  );
  assert.equal(run('runs', 'list', '--state', 'succeeded').length, 1);
  assert.equal(run('status').counts.succeeded, 1);

  daemon.kill('SIGTERM');
  assert.equal((await stopped)[0], 0);
  console.log(
    'CLI smoke passed: jobs add → serve dispatches the queued run → open commands → graceful shutdown → reopen',
  );
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGKILL');
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
