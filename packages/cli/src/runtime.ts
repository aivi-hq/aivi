/** A managed Node under `<home>/runtime/`, used only when the machine's Node
 *  does not satisfy the server's engines range. The tarball comes from
 *  nodejs.org for the running platform; the previous managed version is
 *  deleted only after a replacement is in place. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from 'semver';

export function tarballName(platform: string, arch: string, version: string): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
  const a = arch === 'arm64' || arch === 'x64' ? arch : undefined;
  if (!os || !a) throw new Error(`No managed Node for ${platform}/${arch}; install Node ${version} yourself.`);
  return `node-v${version}-${os}-${a}.tar.gz`;
}

function nodeVersionAt(nodePath: string): string {
  const result = spawnSync(nodePath, ['-v'], { encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`${nodePath} does not run`);
  return result.stdout.trim().replace(/^v/, '');
}

function existingRuntime(home: string, range: string): string | undefined {
  const runtimeDir = join(home, 'runtime');
  if (!existsSync(runtimeDir)) return undefined;
  const candidates = readdirSync(runtimeDir).sort().reverse();
  for (const entry of candidates) {
    const nodePath = join(runtimeDir, entry, 'bin', 'node');
    if (existsSync(nodePath) && satisfies(nodeVersionAt(nodePath), range)) return nodePath;
  }
  return undefined;
}

async function newestRelease(major: number): Promise<string> {
  const response = await fetch('https://nodejs.org/dist/index.json');
  const releases = (await response.json()) as { version: string }[];
  const newest = releases.find(release => release.version.startsWith(`v${major}.`));
  if (!newest) throw new Error(`No Node v${major}.x release found on nodejs.org`);
  return newest.version.slice(1);
}

export async function ensureNode(home: string, range: string): Promise<string> {
  if (satisfies(process.version, range)) return process.execPath;
  const existing = existingRuntime(home, range);
  if (existing) return existing;

  const major = Number(range.match(/>=(\d+)/)?.[1] ?? 0);
  if (!major) throw new Error(`Cannot read the required Node major from "${range}"`);
  const version = await newestRelease(major);
  const name = tarballName(process.platform, process.arch, version);
  const runtimeDir = join(home, 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const tgz = join(runtimeDir, name);
  writeFileSync(tgz, Buffer.from(await (await fetch(`https://nodejs.org/dist/v${version}/${name}`)).arrayBuffer()));
  const result = spawnSync('tar', ['-xzf', name, '-C', runtimeDir], { cwd: runtimeDir });
  rmSync(tgz);
  if (result.status !== 0) throw new Error(`Extracting ${name} failed`);
  const nodePath = join(runtimeDir, name.replace('.tar.gz', ''), 'bin', 'node');
  if (!satisfies(nodeVersionAt(nodePath), range))
    throw new Error(`The downloaded Node ${version} does not satisfy "${range}"`);
  return nodePath;
}

/** The engines range the server publishes; the shape aivi itself controls. */
export function serverRange(appDir: string): string {
  const manifest = JSON.parse(readFileSync(join(appDir, 'node_modules', '@aivi', 'app', 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  return manifest.engines?.node ?? '>=26.0.0 <27';
}
