import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/app/dist/cli.js', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'aivi-smoke-'));
const config = join(directory, 'aivi.json');
let daemon;
let stopped;
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
  await writeFile(task, JSON.stringify({ kind: 'system.check' }));
  // The temp directory is the aivi home: aivi.json, .env and state/ live there.
  const env = { ...process.env, AIVI_HOME: directory };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env }));
  assert.equal(run('config', 'check').valid, true);
  const job = run('jobs', 'enqueue', task, '--key', 'smoke');
  assert.equal(run('jobs', 'enqueue', task, '--key', 'smoke').id, job.id);
  run('tick');
  assert.equal(run('jobs', 'show', job.id).job.result.sources[0].available, true);
  assert.equal(run('status').counts.succeeded, 1);

  const token = randomBytes(32).toString('hex');
  daemon = spawn(process.execPath, [cli, 'serve'], {
    env: { ...env, AIVI_TOKEN: token },
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
  const response = await fetch(`http://127.0.0.1:${listening.port}/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).counts.succeeded, 1);
  assert.equal(
    (await fetch(`http://127.0.0.1:${listening.port}/v1/status`)).status,
    401,
    'token mode rejects anonymous callers',
  );
  assert.equal((await fetch(`http://127.0.0.1:${listening.port}/health`)).status, 200, 'liveness is public');
  daemon.kill('SIGTERM');
  const [code] = await stopped;
  assert.equal(code, 0);
  run('tick'); // clean shutdown released singleton ownership

  // Auth mode "none" serves without a token, for trusted networks.
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      host: { port: 0, auth: { mode: 'none' } },
      opencode: { lifecycle: 'discover' },
      knowledge: [{ id: 'demo', path: '.' }],
    }),
  );
  daemon = spawn(process.execPath, [cli, 'serve'], {
    env: { ...env, AIVI_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stopped = once(daemon, 'exit');
  const open = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Host startup timed out')), 10000);
    let buffer = '';
    daemon.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Host exited during startup: ${code}`));
    });
    daemon.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        clearTimeout(timeout);
        resolve(JSON.parse(buffer.split('\n')[0]).listening);
      }
    });
  });
  assert.equal(
    (await fetch(`http://127.0.0.1:${open.port}/v1/status`, { signal: AbortSignal.timeout(5000) })).status,
    200,
  );
  daemon.kill('SIGTERM');
  assert.equal((await stopped)[0], 0);
  console.log('CLI smoke passed: enqueue → execute → inspect → serve (token, none) → graceful shutdown → reopen');
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGKILL');
    await stopped;
  }
  await rm(directory, { recursive: true, force: true });
}
