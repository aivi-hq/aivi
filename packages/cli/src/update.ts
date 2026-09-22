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
import { ensureNode, serverRange } from './runtime.ts';
import { serviceInstalled, serviceStart, serviceStop } from './service.ts';

export interface UpdateIo {
  npmView(spec: string, field: string): Promise<string>;
  install(specs: string[], appDir: string): { status: number; stderr: string };
  log(message: string): void;
  healthProbe(url: string): Promise<boolean>;
  service: { installed(): boolean; stop(): void; start(): void };
}

export const defaultIo: UpdateIo = {
  async npmView(spec, field) {
    const result = spawnNpm(['view', spec, field, '--json']);
    if (result.status !== 0) throw new Error(`npm view ${spec} ${field} failed: ${result.stderr?.trim()}`);
    return JSON.parse(result.stdout!.trim()) as string;
  },
  install(specs, appDir) {
    const result = spawnNpm(['install', '--save-exact', '--no-fund', ...specs], appDir);
    return { status: result.status ?? 1, stderr: result.stderr?.toString() ?? '' };
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
  service: { installed: serviceInstalled, stop: serviceStop, start: serviceStart },
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

export async function updateServer(options: UpdateOptions, io: UpdateIo = defaultIo): Promise<void> {
  const { home, appDir } = options;
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) throw new Error(`No config.json in ${home}. Run \`aivi setup\`.`);
  const rawConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { update?: { channel?: string } };
  const channel = rawConfig.update?.channel ?? 'stable';
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) throw new Error(`Unknown update channel: ${channel}`);

  const installed = installedDependencies(appDir);
  if (!installed['@aivi/app']) throw new Error(`No aivi server installed at ${appDir}. Run \`aivi setup\`.`);
  const currentVersion = JSON.parse(
    readFileSync(join(appDir, 'node_modules', '@aivi', 'app', 'package.json'), 'utf8'),
  ) as { version: string };

  const targetVersion = await io.npmView(`@aivi/app@${channel === 'stable' ? 'latest' : channel}`, 'version');
  if (targetVersion === currentVersion.version) {
    io.log(`Already up to date: @aivi/app ${targetVersion}.`);
    return;
  }

  // The target's engines gate the update before anything is stopped. An
  // unsuitable Node provisions the managed runtime first.
  const engines = await io.npmView(`@aivi/app@${targetVersion}`, 'engines.node').catch(() => '');
  let nodePath = options.nodePath;
  if (engines && !satisfies(nodeVersion(nodePath), engines)) {
    io.log(`The target needs Node ${engines}; provisioning the managed runtime.`);
    nodePath = await ensureNode(home, engines);
    saveClientConfig({ nodePath });
  }

  const url = await healthUrl(home);
  const managed = io.service.installed();
  if (managed) io.service.stop();
  else if (await io.healthProbe(url))
    throw new Error('aivi is running in the foreground; stop it (Ctrl+C) and re-run `aivi update`.');

  // Install the new server with every plugin at its latest; npm is the peer
  // resolver. A plugin whose peer range excludes the new host is pinned where
  // it is and excluded from this and future retries until its range catches up.
  const plugins = Object.entries(installed).filter(([name]) => name !== '@aivi/app');
  const excluded = new Set<string>();
  let specs = [`@aivi/app@${targetVersion}`, ...plugins.map(([name]) => `${name}@latest`)];
  for (;;) {
    const attempt = io.install(specs, appDir);
    if (attempt.status === 0) break;
    const conflict = attempt.stderr.match(/While resolving: (@aivi\/[a-z-]+)@/)?.[1];
    if (!conflict || conflict === '@aivi/app' || excluded.has(conflict))
      throw new Error(`npm install failed:\n${attempt.stderr}`);
    excluded.add(conflict);
    const kept = installed[conflict];
    io.log(`${conflict}: disabled: no compatible release (kept ${kept})`);
    specs = specs.filter(spec => !spec.startsWith(`${conflict}@`));
  }

  io.log(`Updated @aivi/app: ${currentVersion.version} → ${targetVersion}.`);
  if (managed) {
    io.service.start();
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (await io.healthProbe(url)) {
        io.log('The server is back and healthy.');
        break;
      }
      if (Date.now() > deadline)
        throw new Error(
          'The update installed, but the server did not come healthy within 30 s. Check the service logs.',
        );
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } else {
    io.log('Done. Start the server with `aivi serve`.');
  }
}

function nodeVersion(nodePath: string): string {
  if (nodePath === process.execPath) return process.version;
  const result = spawnSync(nodePath, ['-v'], { encoding: 'utf8' });
  return result.stdout.trim().replace(/^v/, '') || '0.0.0';
}
