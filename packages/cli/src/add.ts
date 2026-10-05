/** `aivi add` — add a plugin to the server home and let it configure itself:
 *  npm installs the package into `<home>/app`, the package's own `./setup`
 *  entry prints its platform instructions, asks for and verifies the secrets,
 *  and writes config.json plus .env; the package joins the `aivi-plugins` list
 *  in app/package.json, the editor schema is rebuilt, and aivi is restarted
 *  only when the module itself reports running. The CLI knows four aliases and
 *  nothing else platform-specific — anything else adds by its npm package name
 *  or by a directory spec (`file:../../packages/browser`, the way a development
 *  home installs its workspace builds: the package's own package.json says its
 *  name), and speaks through its own setup entry. The list holds package
 *  names; the module id is the plugin's own declaration, which is what
 *  `./setup` answers with and what `/status` is watched for. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addPluginName, dependencyNames, pluginDependencies, serverPackage } from './manifest.ts';
import { importApp } from './mount.ts';
import { serviceInstalled, serviceRestart } from './service.ts';
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
  service: { installed(): boolean; restart(): void };
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
      home: options.home,
      configPath: join(options.home, 'config.json'),
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
  service: { installed: serviceInstalled, restart: serviceRestart },
  log: message => console.log(message),
  warn: message => console.log(message),
};

function packageDir(appDir: string, pkg: string): string {
  return join(appDir, 'node_modules', ...pkg.split('/'));
}

/** A spec may name a directory instead of a registry package —
 *  `file:../../packages/browser`, `./local-plugin`, an absolute path — the way
 *  a development home installs its workspace builds. The directory's own
 *  package.json says the name npm installs it under; any other spec is
 *  already that name (a trailing `@version` is npm's, not the name's). */
function packageOfSpec(appDir: string, spec: string): string {
  const bare = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  if (!(bare.startsWith('.') || bare.startsWith('/')))
    return spec.lastIndexOf('@') > 0 ? spec.slice(0, spec.lastIndexOf('@')) : spec;
  const dir = resolve(appDir, bare);
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    throw new Error(`${spec} names no readable package: ${dir}/package.json does not answer.`);
  }
  if (typeof name !== 'string' || name === '') throw new Error(`${dir}/package.json declares no name.`);
  return name;
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
function installPackage(io: AddIo, spec: string, pkg: string, appDir: string): void {
  const dest = packageDir(appDir, pkg);
  if (existsSync(dest)) {
    io.log(`${pkg} ${installedVersion(dest)} is already installed; nothing to install.`);
    return;
  }
  io.log(`Installing ${spec} into ${appDir}`);
  io.install(spec, appDir);
}

/** The npm name behind a spec: the dependency npm just added, or — when npm
 *  had nothing to add because the package was there — the dependency that
 *  already points at it (a trailing `@version` is npm's, not the name's).
 *  The list holds names; npm was handed the specs. */
function dependencyFor(appDir: string, spec: string, before: string[]): string {
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
  // The one notice ("server restarting…") rides inside serviceRestart: the
  // chokepoint announces before the host drops, whoever asked — over an exec
  // relay this command's own process is the host's child and dies with it.
  io.service.restart();
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
  const pkg = packageOfSpec(options.appDir, spec);
  if (pkg === '@aivi/host' || pkg === '@aivi/cli')
    throw new Error('The server and this CLI come from `aivi setup` and npm, not from add.');
  if (!existsSync(packageDir(options.appDir, serverPackage)))
    throw new Error(`No aivi server installed at ${options.appDir}. Run \`aivi setup\` first.`);

  const before = dependencyNames(options.appDir);
  installPackage(io, spec, pkg, options.appDir);
  // The list holds package names: the resolved one speaks for a path spec
  // (`file:../../packages/browser` is what npm was handed, `@aivi/browser` is
  // the fact), and npm's own diff still gets the last word when it surprises.
  const listed = dependencyNames(options.appDir).includes(pkg) ? pkg : dependencyFor(options.appDir, spec, before);

  // The plugin configures itself: instructions, prompts, verification and
  // writes all live in its ./setup entry, run in-process; the flow's ending
  // is its own last line. The list entry waits for the setup to have spoken,
  // so a stopped flow leaves the package installed but inert: no entry means
  // the server never imports it, and the block was never written.
  const moduleId = await setupOrSay(io, listed, options);
  if (process.exitCode) {
    io.log('Nothing joined the plugin list, and nothing was restarted.');
    return;
  }

  // The three facts land together: npm's dependency (above), the list entry,
  // and the block the plugin wrote. Then the editor sees the new shape.
  addPluginName(options.appDir, listed);
  await rebuildSchemaOrSay(io, options.home, options.appDir);

  // With no service installed the CLI has nothing to add: a running
  // foreground server is the operator's to restart, and the setup flow has
  // just said so in its own last line.
  if (!io.service.installed()) return;
  const url = await io.healthUrl(options.home);
  const label = moduleId ? `${moduleId[0]!.toUpperCase()}${moduleId.slice(1)}` : listed;
  await restartAndReport(io, url, label, moduleId);
}

/** Run the plugin's own setup flow; its failure is said in the flow's own
 *  last line and kept as the exit code — the caller reads that and stops. */
async function setupOrSay(io: AddIo, listed: string, options: AddOptions): Promise<string | undefined> {
  try {
    return await io.setupPlugin(listed, options);
  } catch (error) {
    io.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return undefined;
  }
}

/** The editor's schema rebuild after a join: a failure is said and never
 *  fatal — the plugin is listed, and `aivi add` or `aivi update` rebuilds
 *  the cache once config.json loads again. */
async function rebuildSchemaOrSay(io: AddIo, home: string, appDir: string): Promise<void> {
  try {
    await io.rebuildSchema(home, appDir);
  } catch (error) {
    io.warn(
      `the editor schema was not rebuilt (${error instanceof Error ? error.message : String(error)}); the plugin is listed, and \`aivi add\` or \`aivi update\` rebuilds the cache once config.json loads again.`,
    );
  }
}
