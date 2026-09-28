/** `aivi add` — add a plugin to the server home and let it configure itself:
 *  npm installs the package into `<home>/app`, the package's own `./setup`
 *  entry prints its platform instructions, asks for and verifies the secrets,
 *  and writes config.json plus .env; the package joins the `aivi-plugins` list
 *  in app/package.json, the editor schema is rebuilt, and aivi is restarted
 *  only when the module itself reports running. The CLI knows four aliases and
 *  nothing else platform-specific — anything else adds by its npm package name
 *  and speaks through its own setup entry. The list holds package names; the
 *  module id is the plugin's own declaration, which is what `./setup` answers
 *  with and what `/status` is watched for. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addPluginName, dependencyNames, pluginDependencies, serverPackage } from './manifest.ts';
import { importApp } from './mount.ts';
import { serviceInstalled, serviceStart, serviceStop } from './service.ts';
import { healthUrl, waitHealthy } from './update.ts';
import { aiviVersion } from './version.ts';

/** Short names for the plugins aivi ships; any npm package name is accepted too. */
export const PLUGIN_ALIASES: Record<string, string> = {
  discord: '@aivi/channel-discord',
  slack: '@aivi/channel-slack',
  browser: '@aivi/browser',
  linear: '@aivi/tracker-linear',
};

export interface AddOptions {
  home: string;
  appDir: string;
  nodePath: string;
}

export interface ModuleState {
  id: string;
  state: string;
  lastError: string | null;
}

export interface AddIo {
  install(spec: string, appDir: string): void;
  /** Run the plugin's own `./setup` in-process in the installed app's code;
   *  answers the module id it enabled, or undefined when the flow stopped. */
  setupPlugin(spec: string, options: AddOptions): Promise<string | undefined>;
  /** Rebuild `<state>/cache/schema.json` and config.json's `$schema` line. */
  rebuildSchema(home: string, appDir: string): Promise<void>;
  healthUrl(home: string): Promise<string>;
  healthProbe(url: string): Promise<boolean>;
  moduleStates(url: string): Promise<ModuleState[]>;
  service: { installed(): boolean; stop(): void; start(): void };
  log(message: string): void;
  warn(message: string): void;
}

const defaultIo: AddIo = {
  install(spec, appDir) {
    const result = spawnSync('npm', ['install', '--save-exact', '--no-fund', spec], {
      cwd: appDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install ${spec} failed (exit ${result.status ?? 'signal'})`);
  },
  async setupPlugin(spec, options) {
    // The plugin's setup entry runs in-process, as the server's own action
    // does: the host cli context first (it loads .env and the config the way
    // every command reaches them), then pluginSetup with its writers. A stop
    // is not a rejection: pluginSetup says its own words and marks the exit.
    const app = await importApp<{
      home: string;
      configPath: string;
      context: () => Promise<{ loaded: { config: { identity: { name: string } } } }>;
    }>(options.appDir, options.home, 'dist/cli/context.js');
    const { loaded } = await app.context();
    const { pluginSetup } = await importApp<{
      pluginSetup: (
        spec: string,
        options: { home: string; configPath: string; identityName: string },
      ) => Promise<string | undefined>;
    }>(options.appDir, options.home, 'dist/cli/plugin-setup.js');
    return pluginSetup(spec, {
      home: app.home,
      configPath: app.configPath,
      identityName: loaded.config.identity.name,
    });
  },
  async rebuildSchema(home, appDir) {
    const { writeEditorSchema } = await importApp<{ writeEditorSchema: (home: string) => Promise<string> }>(
      appDir,
      home,
      'dist/cli/schema-cache.js',
    );
    await writeEditorSchema(home);
  },
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
  warn: message => console.log(message),
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
function installPackage(io: AddIo, spec: string, appDir: string): void {
  const dest = packageDir(appDir, spec);
  if (existsSync(dest)) {
    io.log(`${spec} ${installedVersion(dest)} is already installed; nothing to install.`);
    return;
  }
  io.log(`Installing ${spec} into ${appDir}`);
  io.install(spec, appDir);
}

/** The npm name behind a spec: the dependency npm just added, or — when npm
 *  had nothing to add because the package was there — the dependency that
 *  already points at it (a trailing `@version` is npm's, not the name's).
 *  The list holds names; npm was handed the specs. */
export function dependencyFor(appDir: string, spec: string, before: string[]): string {
  const added = pluginDependencies(appDir).filter(name => !before.includes(name));
  if (added.length === 1) return added[0]!;
  if (added.length > 1)
    throw new Error(
      `npm added ${added.length} dependencies (${added.join(', ')}); say which one is the plugin by naming it in aivi-plugins in app/package.json.`,
    );
  const at = spec.lastIndexOf('@');
  const bare = at > 0 ? spec.slice(0, at) : spec;
  if (dependencyNames(appDir).includes(bare)) return bare;
  throw new Error(`Cannot tell which package ${spec} installed; name it in aivi-plugins in app/package.json.`);
}

/** Bring it up: restart aivi, then read the module's own health. The command
 *  ends only when the module itself reports running (or gives a reason). */
async function restartAndReport(io: AddIo, url: string, label: string, moduleId: string | undefined) {
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

export async function add(args: string[], options: AddOptions, io: AddIo = defaultIo): Promise<void> {
  const flags = args.filter(arg => arg.startsWith('-'));
  if (flags.length) throw new Error(`Unknown add flag: ${flags[0]}`);
  const name = args[0];
  if (!name) throw new Error('Add what? aivi add browser|discord|slack|linear|NPM-PACKAGE');
  const spec = PLUGIN_ALIASES[name] ?? name;
  if (spec === '@aivi/host' || spec === '@aivi/cli')
    throw new Error('The server and this CLI come from `aivi setup` and npm, not from add.');
  if (!existsSync(packageDir(options.appDir, serverPackage)))
    throw new Error(`No aivi server installed at ${options.appDir}. Run \`aivi setup\` first.`);

  const before = dependencyNames(options.appDir);
  installPackage(io, spec, options.appDir);
  const pkg = dependencyFor(options.appDir, spec, before);

  // The plugin configures itself: instructions, prompts, verification and
  // writes all live in its ./setup entry, run in-process; the flow's ending
  // is its own last line. The list entry waits for the setup to have spoken,
  // so a stopped flow leaves the package installed but inert: no entry means
  // the server never imports it, and the block was never written.
  let moduleId: string | undefined;
  try {
    moduleId = await io.setupPlugin(spec, options);
  } catch (error) {
    io.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  if (process.exitCode) {
    io.log('Nothing joined the plugin list, and nothing was restarted.');
    return;
  }

  // The three facts land together: npm's dependency (above), the list entry,
  // and the block the plugin wrote. Then the editor sees the new shape.
  addPluginName(options.appDir, pkg);
  try {
    await io.rebuildSchema(options.home, options.appDir);
  } catch (error) {
    io.warn(
      `the editor schema was not rebuilt (${error instanceof Error ? error.message : String(error)}); the plugin is listed, and \`aivi add\` or \`aivi update\` rebuilds the cache once config.json loads again.`,
    );
  }

  // With no service installed the CLI has nothing to add: a running
  // foreground server is the operator's to restart, and the setup flow has
  // just said so in its own last line.
  if (!io.service.installed()) return;
  const url = await io.healthUrl(options.home);
  const label = moduleId ? `${moduleId[0]!.toUpperCase()}${moduleId.slice(1)}` : pkg;
  await restartAndReport(io, url, label, moduleId);
}
