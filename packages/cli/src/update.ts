/** `aivi update` — bring the installed server and its plugins to their newest
 *  compatible releases. `config.json` records what is desired, `app/package.json`
 *  what is installed; this command reconciles them. npm is the compatibility
 *  resolver: a plugin whose peer range excludes the new host fails the install,
 *  is pinned at its current version with "disabled: no compatible release", and
 *  is re-checked on every future update. No rollback: the update is verified by
 *  probing /health after the restart, and crossing a schema migration is the
 *  operator's responsibility. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { saveClientConfig } from './client-config.ts';
import { importApp } from './mount.ts';
import { ensureNode } from './runtime.ts';
import { serviceInstalled, serviceRestart } from './service.ts';

export interface UpdateIo {
  npmView(spec: string, field: string): Promise<string>;
  install(specs: string[], appDir: string): { status: number; stderr: string };
  /** Rebuild `<state>/cache/schema.json` and config.json's `$schema` line, in
   *  the installed app's code; called after the peers are updated. */
  rebuildSchema(home: string, appDir: string): Promise<void>;
  log(message: string): void;
  healthProbe(url: string): Promise<boolean>;
  /** The managed host keeps answering through the install; the one
   *  disconnect is the final restart, and its announce rides inside
   *  serviceRestart (D13: announce first, then do the disconnecting thing). */
  service: { installed(): boolean; restart(): void };
}

const defaultIo: UpdateIo = {
  async npmView(spec, field) {
    const result = spawnNpm(['view', spec, field, '--json']);
    if (result.status !== 0) throw new Error(`npm view ${spec} ${field} failed: ${result.stderr?.trim()}`);
    return JSON.parse(result.stdout!.trim()) as string;
  },
  install(specs, appDir) {
    const result = spawnNpm(['install', '--save-exact', '--no-fund', ...specs], appDir);
    return { status: result.status ?? 1, stderr: result.stderr?.toString() ?? '' };
  },
  async rebuildSchema(home, appDir) {
    const { writeEditorSchema } = await importApp<{ writeEditorSchema: (home: string) => Promise<string> }>(
      appDir,
      home,
      'dist/cli/schema-cache.js',
    );
    await writeEditorSchema(home);
  },
  log: message => console.log(message),
  async healthProbe(url) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  },
  service: { installed: serviceInstalled, restart: serviceRestart },
};

function spawnNpm(args: string[], cwd?: string) {
  return spawnSync('npm', args, { ...(cwd ? { cwd } : {}), encoding: 'utf8' });
}

export interface UpdateOptions {
  home: string;
  appDir: string;
  nodePath: string;
}

const CHANNELS = ['stable'] as const;

/** The host url the server in this home answers on. The app's own defaults
 *  stand when config.json is missing or unreadable: `aivi uninstall` probes
 *  here too, and a broken config must not hide a running server. */
export async function healthUrl(home: string): Promise<string> {
  let config: { host?: { bind?: string; port?: number } };
  try {
    config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as typeof config;
  } catch {
    config = {};
  }
  const port = config.host?.port ?? 4100;
  const bind = config.host?.bind ?? '127.0.0.1';
  const host = ['0.0.0.0', '::', '[::]'].includes(bind) ? '127.0.0.1' : bind;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

function installedDependencies(appDir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.startsWith('@aivi/')));
}

/** Install the new server with every plugin at its latest; npm is the peer resolver.
 *  A plugin whose peer range excludes the new host is pinned where it is and excluded
 *  from this and future retries until its range catches up. */
function installPeers(io: UpdateIo, appDir: string, installed: Record<string, string>, targetVersion: string): void {
  const plugins = Object.entries(installed).filter(([name]) => name !== '@aivi/host');
  const excluded = new Set<string>();
  let specs = [`@aivi/host@${targetVersion}`, ...plugins.map(([name]) => `${name}@latest`)];
  for (;;) {
    const attempt = io.install(specs, appDir);
    if (attempt.status === 0) return;
    const conflict = attempt.stderr.match(/While resolving: (@aivi\/[a-z-]+)@/)?.[1];
    if (!conflict || conflict === '@aivi/host' || excluded.has(conflict))
      throw new Error(`npm install failed:\n${attempt.stderr}`);
    excluded.add(conflict);
    const kept = installed[conflict];
    io.log(`${conflict}: disabled: no compatible release (kept ${kept})`);
    specs = specs.filter(spec => !spec.startsWith(`${conflict}@`));
  }
}

/** A bounded wait for a known instant: the restarted server coming healthy.
 *  The `failure` message is the diagnosis each caller's operator needs. */
export async function waitHealthy(
  io: { healthProbe(url: string): Promise<boolean> },
  url: string,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await io.healthProbe(url)) return;
    if (Date.now() > deadline) throw new Error(failure);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/** Restart the managed service and wait for it to answer. */
async function restartAndWait(io: UpdateIo, url: string): Promise<void> {
  io.service.restart();
  await waitHealthy(
    io,
    url,
    'The update installed, but the server did not come healthy within 30 s. Check the service logs.',
  );
  io.log('The server is back and healthy.');
}

/** The target's engines gate the update before anything is stopped. An unsuitable
 *  Node provisions the managed runtime first, recorded for the service's benefit. */
async function provisionNode(io: UpdateIo, home: string, targetVersion: string, nodePath: string): Promise<void> {
  const engines = await io.npmView(`@aivi/host@${targetVersion}`, 'engines.node').catch(() => '');
  if (!engines || satisfies(nodeVersion(nodePath), engines)) return;
  io.log(`The target needs Node ${engines}; provisioning the managed runtime.`);
  saveClientConfig({ nodePath: await ensureNode(home, engines) });
}

export async function updateServer(options: UpdateOptions, io: UpdateIo = defaultIo): Promise<void> {
  const { home, appDir } = options;
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) throw new Error(`No config.json in ${home}. Run \`aivi setup\`.`);
  const rawConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { update?: { channel?: string } };
  const channel = rawConfig.update?.channel ?? 'stable';
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) throw new Error(`Unknown update channel: ${channel}`);

  const installed = installedDependencies(appDir);
  if (!installed['@aivi/host']) throw new Error(`No aivi server installed at ${appDir}. Run \`aivi setup\`.`);
  const currentVersion = JSON.parse(
    readFileSync(join(appDir, 'node_modules', '@aivi', 'host', 'package.json'), 'utf8'),
  ) as { version: string };

  const targetVersion = await io.npmView(`@aivi/host@${channel === 'stable' ? 'latest' : channel}`, 'version');
  if (targetVersion === currentVersion.version) {
    io.log(`Already up to date: @aivi/host ${targetVersion}.`);
    return;
  }

  await provisionNode(io, home, targetVersion, options.nodePath);

  // A foreground host is the person's own process to stop and files cannot
  // be swapped safely under it — refuse before touching anything. A managed
  // host keeps answering through the install: an exec session driving this
  // command is the host's own child, and the one disconnect comes last,
  // announced — stopping first would kill the updater mid-npm (D13).
  const url = await healthUrl(home);
  const managed = io.service.installed();
  if (!managed && (await io.healthProbe(url)))
    throw new Error('aivi is running in the foreground; stop it (Ctrl+C) and re-run `aivi update`.');

  installPeers(io, appDir, installed, targetVersion);

  // The `aivi-plugins` list and every other field of app/package.json are
  // invisible to these installs: npm rewrites dependencies only, so the list
  // — the enablement fact — survives the update untouched. The editor schema
  // is rebuilt from the new code; a cache that cannot rebuild is a warning,
  // the same rule as `aivi add`.
  try {
    await io.rebuildSchema(home, appDir);
  } catch (error) {
    io.log(
      `the editor schema was not rebuilt (${error instanceof Error ? error.message : String(error)}); \`aivi add\` or a later \`aivi update\` rebuilds it once config.json loads again.`,
    );
  }

  io.log(`Updated @aivi/host: ${currentVersion.version} → ${targetVersion}.`);
  if (managed) await restartAndWait(io, url);
  else io.log('Done. Start the server with `aivi serve`.');
}

function nodeVersion(nodePath: string): string {
  if (nodePath === process.execPath) return process.version;
  const result = spawnSync(nodePath, ['-v'], { encoding: 'utf8' });
  return result.stdout.trim().replace(/^v/, '') || '0.0.0';
}
