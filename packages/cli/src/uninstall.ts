/** `aivi uninstall` — delete what aivi created on this machine, then delete the
 *  CLI itself. Nothing is interactive: without `--confirm` it lists the paths
 *  it would delete and stops, the same shape as `aivi projects purge`. The
 *  order is the one that cannot leave a mess: the background service first (a
 *  unit whose server is gone gets relaunched forever), then OpenCode's plugin
 *  entry — which lives in OpenCode's own config, outside the home — then the
 *  home and the client config, and the CLI last, because after that spawn it
 *  can neither say nor read anything more. */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clientConfigPath, loadClientConfig } from './client-config.ts';
import { CLI_PACKAGE, detectInstallMethod, type InstallMethod, runInstallMethod } from './install-method.ts';
import { serviceInstalled, serviceUninstall, serviceUnitPath } from './service.ts';
import { AIVI_PLUGIN, ATTRIBUTION_PLUGIN } from './setup.ts';
import { healthUrl } from './update.ts';

export interface UninstallOptions {
  /** The home to delete, resolved the way every command resolves it; undefined
   *  when this machine knows of no home. */
  home: string | undefined;
  confirm: boolean;
  /** The attribution plugin is not aivi's, so it goes only when asked for. */
  withAttribution: boolean;
}

export interface UninstallIo {
  exists(path: string): boolean;
  remove(path: string): void;
  health(url: string): Promise<boolean>;
  service: { installed(): boolean; uninstall(): void };
  opencodeOnPath(): boolean;
  pluginList(): string;
  pluginRemove(pkg: string): void;
  detectMethod(): InstallMethod | undefined;
  selfDelete(method: InstallMethod): void;
  log(message: string): void;
  warn(message: string): void;
}

const defaultIo: UninstallIo = {
  exists: path => existsSync(path),
  remove: path => rmSync(path, { recursive: true, force: true }),
  async health(url) {
    try {
      return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  },
  service: { installed: serviceInstalled, uninstall: serviceUninstall },
  opencodeOnPath: () => spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0,
  pluginList: () => spawnSync('opencode', ['plugin', 'list'], { encoding: 'utf8' }).stdout ?? '',
  pluginRemove(pkg) {
    const result = spawnSync('opencode', ['plugin', 'remove', pkg], { stdio: 'inherit' });
    if (result.status !== 0)
      throw new Error(`opencode plugin remove ${pkg} failed (exit ${result.status ?? 'signal'})`);
  },
  detectMethod: detectInstallMethod,
  selfDelete: method => runInstallMethod(method, 'uninstall'),
  log: message => console.log(message),
  warn: message => console.warn(message),
};

/** True when the job is finished — which includes there having been nothing
 *  here to uninstall. False when it stopped short: a dry run, or a CLI that no
 *  install method aivi knows can remove. */
export async function uninstall(options: UninstallOptions, io: UninstallIo = defaultIo): Promise<boolean> {
  const { home, confirm, withAttribution } = options;
  const clientPath = clientConfigPath();
  const unitPath = serviceUnitPath();
  // Read the install method before the file that records it goes away; it names
  // the method in the one message no probe can answer.
  const recorded = loadClientConfig()?.installMethod;

  // The guard comes before anything else: only the home this machine recorded,
  // and only when it is one — config.json is the first file `aivi setup` writes
  // into it. The whole path is printed below, so nothing here is guessed.
  if (home !== undefined) {
    if (home === resolve('/') || home === resolve(homedir()))
      throw new Error(`${home} is not a directory aivi created. Nothing was deleted.`);
    if (!io.exists(join(home, 'config.json')))
      throw new Error(
        `No config.json at ${home}, so aivi deletes nothing. Check AIVI_HOME and the home field in ${clientPath}.`,
      );
  }

  const unit = unitPath !== undefined && io.exists(unitPath);
  const listed = io.opencodeOnPath() ? io.pluginList() : '';
  const method = io.detectMethod();
  const attribution = listed.includes(ATTRIBUTION_PLUGIN);
  const lines = [
    ...(home === undefined ? [] : [`  ${home}  the aivi home`]),
    ...(io.exists(clientPath) ? [`  ${clientPath}  the client config: this machine's sign-in`] : []),
    ...(unit && unitPath !== undefined ? [`  ${unitPath}  the background service`] : []),
    ...(listed.includes(AIVI_PLUGIN) ? [`  ${AIVI_PLUGIN}  aivi's OpenCode plugin`] : []),
    ...(attribution
      ? [
          confirm && withAttribution
            ? `  ${ATTRIBUTION_PLUGIN}  the attribution OpenCode plugin`
            : `  ${ATTRIBUTION_PLUGIN}  kept: it is not aivi's — add --with-attribution to remove it`,
        ]
      : []),
    ...(method === undefined ? [] : [`  ${CLI_PACKAGE}  this CLI, installed with ${method}`]),
  ];

  io.log(confirm ? 'Deleting:' : 'aivi uninstall would delete:');
  for (const line of lines) io.log(line);

  if (!confirm) {
    if (!lines.length) {
      io.log('aivi is not installed here: no home, no client config, and no CLI an install method knows.');
      return true;
    }
    io.log('Nothing deleted. Re-run with --confirm to delete these; the home cannot be recovered.');
    return false;
  }

  // The unit goes first: launchd or systemd would relaunch a server whose files
  // are gone, forever. A server in the foreground is the person's own process,
  // so it is theirs to stop — the same refusal `aivi update` makes.
  if (io.service.installed()) io.service.uninstall();
  else if (home !== undefined && (await io.health(await healthUrl(home))))
    throw new Error('aivi is running in the foreground; stop it (Ctrl+C) and re-run `aivi uninstall`.');

  // OpenCode keeps plugins in its own global config, which the home never takes
  // with it. A failure says so and continues: the deletion is what was asked.
  if (io.opencodeOnPath()) {
    if (listed.includes(AIVI_PLUGIN)) removePlugin(io, AIVI_PLUGIN);
    if (withAttribution && attribution) removePlugin(io, ATTRIBUTION_PLUGIN);
    else if (attribution) io.log(`Kept ${ATTRIBUTION_PLUGIN}: \`opencode plugin remove ${ATTRIBUTION_PLUGIN}\`.`);
  } else if (home !== undefined)
    io.warn(
      `OpenCode is not on PATH, so its plugin entries were left. Remove them by hand: ` +
        `opencode plugin remove ${AIVI_PLUGIN}${withAttribution ? ` && opencode plugin remove ${ATTRIBUTION_PLUGIN}` : ''}`,
    );

  if (home !== undefined) {
    io.remove(home);
    io.log(`Deleted ${home}`);
  }
  if (io.exists(clientPath)) {
    io.remove(clientPath);
    io.log(`Deleted ${clientPath}`);
  }

  // Last: the CLI removes itself. Nothing may read or write after this line —
  // the files this command deletes are its own.
  if (method === undefined) {
    io.warn(
      `The aivi files are gone. No install method aivi knows answers${
        recorded ? `, and the client config recorded ${recorded}` : ''
      }; remove the CLI the way you installed it.`,
    );
    return false;
  }
  io.log(`Removing this CLI (installed with ${method}) — the last thing it says.`);
  io.selfDelete(method);
  return true;
}

function removePlugin(io: UninstallIo, pkg: string): void {
  try {
    io.pluginRemove(pkg);
    io.log(`Removed the ${pkg} plugin from OpenCode.`);
  } catch (error) {
    io.warn(
      `Could not remove the ${pkg} plugin (${error instanceof Error ? error.message : String(error)}). ` +
        `Remove it by hand: opencode plugin remove ${pkg}`,
    );
  }
}
