/** The release gate for the thin CLI: the published artifact is installed
 *  alone and made to run. Inside the workspace every import resolves through
 *  the root node_modules hoist, so `npm test` cannot see what a person's
 *  `npm i -g @aivi/cli` sees — `aivi help` died in the wild that way (the
 *  banner reached for @aivi/core, which resolves in the repo and nowhere
 *  else). This script packs the tarball, installs it into an empty prefix,
 *  and runs the binary: help, version, and the deprecation redirect. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const prefix = await mkdtemp(join(tmpdir(), 'aivi-pack-smoke-'));
const run = (file, args, options = {}) =>
  execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', ...options });
const npm = (args, options = {}) => execFileSync('npm', args, { encoding: 'utf8', ...options });

try {
  // The pack triggers `prepack`, so the tarball is built from the current sources.
  const tarball = npm(['pack', join(repo, 'packages/cli'), '--pack-destination', prefix], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .trim()
    .split('\n')
    .at(-1);
  const installed = join(prefix, 'node_modules', '.bin', 'aivi');
  await writeFile(join(prefix, 'package.json'), JSON.stringify({ name: 'aivi-pack-smoke', private: true }));
  npm(['install', tarball, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: prefix });

  // The binary must answer before any installation exists.
  const help = run(installed, ['help']);
  if (!help.includes('Usage: aivi') || !help.includes('setup')) throw new Error(`aivi help lost its words:\n${help}`);
  const version = run(installed, ['--version']).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`aivi --version said: ${version}`);
  // The forward path without any home must say so, not crash with a module
  // error. HOME and XDG_CONFIG_HOME are fenced to the prefix so a development
  // machine's own installation cannot answer for the smoke.
  const fenced = {
    ...process.env,
    HOME: prefix,
    XDG_CONFIG_HOME: join(prefix, 'xdg'),
  };
  delete fenced.AIVI_HOME;
  try {
    run(installed, ['status'], { env: fenced });
    throw new Error('aivi status without a home should fail');
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (error.status === 0 || !/No aivi home known|No aivi server/.test(stderr))
      throw new Error(`aivi status without a home said: ${stderr || error.message}`);
  }
  console.log(`pack-smoke: @aivi/cli ${version} installed alone and answers.`);
} finally {
  await rm(prefix, { recursive: true, force: true });
}
