/** `aivi install` — add a plugin to the server home and let it configure
 *  itself: npm installs the package into `<home>/app`, the package's own
 *  `./setup` entry prints its platform instructions, asks for and verifies
 *  the secrets, and writes config.json plus .env; then aivi is restarted and
 *  the command ends only when the module itself reports running. The CLI
 *  knows two aliases and nothing else platform-specific — anything else
 *  installs by its npm name and speaks through its own setup entry. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forward } from './forward.ts';
import { serviceInstalled, serviceStart, serviceStop } from './service.ts';
import { healthUrl, waitHealthy } from './update.ts';
import { aiviVersion } from './version.ts';

/** Short names for the plugins aivi ships; any npm package name is accepted too. */
export const PLUGIN_ALIASES: Record<string, string> = {
  discord: '@aivi/channel-discord',
  slack: '@aivi/channel-slack',
  browser: '@aivi/browser',
};

/** The module each first-party plugin enables — the id `/status` reports. */
const MODULE_BY_SPEC: Record<string, string> = {
  '@aivi/channel-discord': 'discord',
  '@aivi/channel-slack': 'slack',
  '@aivi/browser': 'browser',
};

export interface InstallOptions {
  home: string;
  appDir: string;
  nodePath: string;
}

export interface ModuleState {
  id: string;
  state: string;
  lastError: string | null;
}

export interface InstallIo {
  install(spec: string, appDir: string): void;
  forwardSetup(spec: string, options: InstallOptions): number;
  healthUrl(home: string): Promise<string>;
  healthProbe(url: string): Promise<boolean>;
  moduleStates(url: string): Promise<ModuleState[]>;
  service: { installed(): boolean; stop(): void; start(): void };
  log(message: string): void;
}

const defaultIo: InstallIo = {
  install(spec, appDir) {
    const result = spawnSync('npm', ['install', '--save-exact', '--no-fund', spec], {
      cwd: appDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install ${spec} failed (exit ${result.status ?? 'signal'})`);
  },
  forwardSetup: (spec, options) => forward(['plugin', 'setup', spec], options),
  healthUrl,
  async healthProbe(url) {
    try {
      return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  },
  async moduleStates(url) {
    const response = await fetch(`${url}/status`, {
      headers: { 'x-aivi-client': aiviVersion },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`/status answered ${response.status}.`);
    return ((await response.json()) as { modules: ModuleState[] }).modules;
  },
  service: { installed: serviceInstalled, stop: serviceStop, start: serviceStart },
  log: message => console.log(message),
};

function packageDir(appDir: string, spec: string): string {
  return join(appDir, 'node_modules', ...spec.split('/'));
}

function installedVersion(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Install the package into the home. npm owns what is installed; --save-exact
 *  keeps the plugin in app/package.json, where `aivi update` carries it along from. */
function installPackage(io: InstallIo, spec: string, appDir: string): void {
  const dest = packageDir(appDir, spec);
  if (existsSync(dest)) {
    io.log(`${spec} ${installedVersion(dest)} is already installed; nothing to install.`);
    return;
  }
  io.log(`Installing ${spec} into ${appDir}`);
  io.install(spec, appDir);
}

/** Bring it up: restart aivi, then read the module's own health. The command
 *  ends only when the module itself reports running (or gives a reason). */
async function restartAndReport(io: InstallIo, url: string, label: string, moduleId: string | undefined) {
  io.log('Restarting aivi…');
  io.service.stop();
  io.service.start();
  // A bounded wait for a known instant: the restarted server coming healthy,
  // the same probe `aivi update` runs.
  await waitHealthy(io, url, 'aivi did not come back healthy within 30 s. Check `aivi service logs`.');
  const seen = moduleId ? (await io.moduleStates(url)).find(state => state.id === moduleId) : undefined;
  if (seen?.state === 'running') io.log(`${label} is running.`);
  else if (seen?.state === 'degraded') {
    io.log(
      `${label} is degraded so far: ${seen.lastError ?? 'no reason given'}. aivi keeps retrying; \`aivi status\` follows it.`,
    );
    process.exitCode = 1;
  } else io.log('aivi is back and healthy.');
}

export async function install(args: string[], options: InstallOptions, io: InstallIo = defaultIo): Promise<void> {
  const flags = args.filter(arg => arg.startsWith('-'));
  if (flags.length) throw new Error(`Unknown install flag: ${flags[0]}`);
  const name = args[0];
  if (!name) throw new Error('Install what? aivi install browser|discord|slack|NPM-SPEC');
  const spec = PLUGIN_ALIASES[name] ?? name;
  if (spec === '@aivi/app' || spec === '@aivi/cli')
    throw new Error('The server and this CLI come from `aivi setup` and npm, not from install.');
  const moduleId = MODULE_BY_SPEC[spec];
  const label = moduleId ? `${moduleId[0]!.toUpperCase()}${moduleId.slice(1)}` : spec;
  if (!existsSync(packageDir(options.appDir, '@aivi/app')))
    throw new Error(`No aivi server installed at ${options.appDir}. Run \`aivi setup\` first.`);

  installPackage(io, spec, options.appDir);

  // The plugin configures itself: instructions, prompts, verification and
  // writes all live in its ./setup entry; the human sees it through inherited stdio.
  const status = io.forwardSetup(spec, options);
  if (status !== 0) {
    io.log('Nothing was restarted.');
    process.exitCode = status;
    return;
  }

  // A running foreground server is the operator's to restart; the CLI never kills it.
  const url = await io.healthUrl(options.home);
  if (!io.service.installed()) {
    if (await io.healthProbe(url))
      io.log(`Configured. aivi is running in the foreground: stop it (Ctrl+C) and start it again to load ${label}.`);
    else io.log(`Configured. Start aivi to bring ${label} up.`);
    return;
  }
  await restartAndReport(io, url, label, moduleId);
}
