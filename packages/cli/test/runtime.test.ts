/** The managed Node as a unit: when the node that runs aivi will do, which
 *  managed runtime will do, and what is fetched, written and run to get one.
 *  The platform, the file system, spawnSync and fetch are mocks, and each
 *  effect is recorded in order. `semver` is the real library. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { ensureNode, tarballName } from '../src/runtime.ts';

const HOME = '/users/test/.aivi';
const RUNTIME = join(HOME, 'runtime');
const RANGE = '>=26 <27';
const MAC = 'node-v26.3.0-darwin-arm64';
const bin = (name: string) => join(RUNTIME, name, 'bin', 'node');

interface Host {
  /** `process.version`: old by default, so the node that runs aivi does not do. */
  version?: string;
  platform?: string;
  arch?: string;
  /** The runtime directory's entries; the directory exists when there are some. */
  listing?: string[];
  /** The paths that exist inside it. */
  present?: string[];
  /** What `node -v` prints, by path; a path that is absent cannot run. */
  nodes?: Record<string, string>;
  /** The exit status of `tar`. */
  tar?: number;
  /** The versions nodejs.org lists, newest first. */
  releases?: string[];
}

/** A machine, and `effects`: what the unit did to it, in order. */
function host(t: TestContext, spec: Host = {}) {
  const effects: string[][] = [];
  const spawnOptions: unknown[] = [];
  const present = new Set([...(spec.present ?? []), ...(spec.listing ? [RUNTIME] : [])]);
  t.mock.property(process, 'version', spec.version ?? 'v25.0.0');
  t.mock.property(process, 'platform', (spec.platform ?? 'darwin') as NodeJS.Platform);
  t.mock.property(process, 'arch', (spec.arch ?? 'arm64') as NodeJS.Architecture);
  t.mock.method(fs, 'existsSync', (path: string) => present.has(path));
  t.mock.method(fs, 'readdirSync', () => spec.listing ?? []);
  t.mock.method(fs, 'mkdirSync', (path: string, options: object) => {
    effects.push(['mkdir', path, JSON.stringify(options)]);
  });
  t.mock.method(fs, 'writeFileSync', (path: string, data: Buffer) => {
    effects.push(['write', path, data.toString()]);
  });
  t.mock.method(fs, 'rmSync', (path: string) => {
    effects.push(['rm', path]);
  });
  t.mock.method(childProcess, 'spawnSync', (command: string, args: string[], options: unknown) => {
    effects.push(['run', command, ...args]);
    spawnOptions.push(options);
    if (command === 'tar') return { status: spec.tar ?? 0 };
    const printed = spec.nodes?.[command];
    return printed === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: `${printed}\n` };
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    effects.push(['fetch', url]);
    return url.endsWith('index.json')
      ? Response.json((spec.releases ?? []).map(version => ({ version })))
      : new Response('tarball-bytes');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { effects, spawnOptions };
}

test('the tarball is named for the platform and the architecture nodejs.org builds for', () => {
  assert.equal(tarballName('darwin', 'arm64', '26.2.0'), 'node-v26.2.0-darwin-arm64.tar.gz');
  assert.equal(tarballName('linux', 'x64', '26.2.0'), 'node-v26.2.0-linux-x64.tar.gz');
  assert.equal(tarballName('linux', 'arm64', '26.2.0'), 'node-v26.2.0-linux-arm64.tar.gz');
  assert.throws(() => tarballName('win32', 'x64', '26.2.0'), /No managed Node for win32\/x64/);
  assert.throws(() => tarballName('linux', 'ia32', '26.2.0'), /No managed Node for linux\/ia32/);
});

test('the node that runs aivi is the node, when it satisfies the range', async t => {
  const h = host(t, { version: 'v26.2.0' });

  assert.equal(await ensureNode(HOME, RANGE), process.execPath);
  assert.deepEqual(h.effects, []);
});

test('a managed runtime is the newest one that has a binary and satisfies the range', async t => {
  const old = 'node-v25.9.0-darwin-arm64';
  const wanted = 'node-v26.1.0-darwin-arm64';
  const h = host(t, {
    listing: [old, wanted, 'node-v26.2.0-darwin-arm64'],
    present: [bin(old), bin(wanted)],
    nodes: { [bin(wanted)]: 'v26.1.0' },
  });

  assert.equal(await ensureNode(HOME, RANGE), bin(wanted));
  assert.deepEqual(h.effects, [['run', bin(wanted), '-v']], 'the newest has no binary: it is skipped, not run');
});

test('a managed runtime that does not run is an error that names it', async t => {
  host(t, { listing: [MAC], present: [bin(MAC)] });

  await assert.rejects(ensureNode(HOME, RANGE), new Error(`${bin(MAC)} does not run`));
});

test('with no runtime that will do, the newest release of the major is fetched, unpacked and checked', async t => {
  const stale = 'node-v25.9.0-darwin-arm64';
  const h = host(t, {
    listing: [stale],
    present: [bin(stale)],
    releases: ['v27.0.0', 'v26.3.0', 'v26.2.0'],
    nodes: { [bin(stale)]: 'v25.9.0', [bin(MAC)]: 'v26.3.0' },
  });

  assert.equal(await ensureNode(HOME, RANGE), bin(MAC));

  assert.deepEqual(h.effects, [
    ['run', bin(stale), '-v'],
    ['fetch', 'https://nodejs.org/dist/index.json'],
    ['mkdir', RUNTIME, '{"recursive":true}'],
    ['fetch', `https://nodejs.org/dist/v26.3.0/${MAC}.tar.gz`],
    ['write', join(RUNTIME, `${MAC}.tar.gz`), 'tarball-bytes'],
    ['run', 'tar', '-xzf', `${MAC}.tar.gz`, '-C', RUNTIME],
    ['rm', join(RUNTIME, `${MAC}.tar.gz`)],
    ['run', bin(MAC), '-v'],
  ]);
  assert.deepEqual(h.spawnOptions[1], { cwd: RUNTIME }, 'tar unpacks where the tarball was put');
});

test('a range that names no major cannot say which release to fetch', async t => {
  host(t);
  await assert.rejects(ensureNode(HOME, '^26'), new Error('Cannot read the required Node major from "^26"'));
});

test('a major that nodejs.org lists no release of is an error', async t => {
  host(t, { releases: ['v27.0.0'] });
  await assert.rejects(ensureNode(HOME, RANGE), new Error('No Node v26.x release found on nodejs.org'));
});

test('a platform with no tarball is told to install Node itself', async t => {
  host(t, { platform: 'win32', releases: ['v26.3.0'] });
  await assert.rejects(
    ensureNode(HOME, RANGE),
    new Error('No managed Node for win32/arm64; install Node 26.3.0 yourself.'),
  );
});

test('a tarball that does not unpack is an error, and is not left behind', async t => {
  const h = host(t, { releases: ['v26.3.0'], tar: 2 });

  await assert.rejects(ensureNode(HOME, RANGE), new Error(`Extracting ${MAC}.tar.gz failed`));

  assert.deepEqual(h.effects.at(-1), ['rm', join(RUNTIME, `${MAC}.tar.gz`)]);
});

test('a download that does not satisfy the range after all is an error', async t => {
  host(t, { releases: ['v26.3.0'], nodes: { [bin(MAC)]: 'v25.0.0' } });
  await assert.rejects(ensureNode(HOME, RANGE), new Error(`The downloaded Node 26.3.0 does not satisfy "${RANGE}"`));
});
