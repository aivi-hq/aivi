/** `aivi remove` — take a plugin out of the server home: its entry leaves the
 *  `aivi-plugins` list in app/package.json, the config block its `./setup`
 *  wrote is dropped, npm uninstalls the package, and the editor schema is
 *  rebuilt before aivi comes back without the module. The module id is asked
 *  from the package's own `./config` declaration while the package is still
 *  installed; the CLI itself edits only the plain-JSON list. This removes
 *  a plugin — `aivi uninstall` is the one that takes aivi off the machine. */
import { spawnSync } from 'node:child_process';
import { PLUGIN_ALIASES } from './add.ts';
import { pluginNames, removePluginName } from './manifest.ts';
import { importApp } from './mount.ts';
import { serviceInstalled, serviceStart, serviceStop } from './service.ts';
import { healthUrl, waitHealthy } from './update.ts';

export interface RemoveOptions {
  home: string;
  appDir: string;
  nodePath: string;
}

export interface RemoveIo {
  /** Ask the installed package its module id and drop its config block. */
  removeBlock(name: string, options: RemoveOptions): Promise<{ moduleId: string; blockRemoved: boolean }>;
  uninstall(name: string, appDir: string): void;
  rebuildSchema(home: string, appDir: string): Promise<void>;
  healthUrl(home: string): Promise<string>;
  healthProbe(url: string): Promise<boolean>;
  service: { installed(): boolean; stop(): void; start(): void };
  log(message: string): void;
  warn(message: string): void;
}

const defaultIo: RemoveIo = {
  async removeBlock(name, options) {
    const { pluginRemove } = await importApp<{
      pluginRemove: (
        name: string,
        options: { configPath: string },
      ) => Promise<{ moduleId: string; blockRemoved: boolean }>;
    }>(options.appDir, options.home, 'dist/cli/plugin-remove.js');
    return pluginRemove(name, { configPath: `${options.home}/config.json` });
  },
  uninstall(name, appDir) {
    const result = spawnSync('npm', ['uninstall', '--no-fund', name], { cwd: appDir, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm uninstall ${name} failed (exit ${result.status ?? 'signal'})`);
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
  service: { installed: serviceInstalled, stop: serviceStop, start: serviceStart },
  log: message => console.log(message),
  warn: message => console.log(message),
};

/** The list entry a name or alias points at; undefined when the home does not
 *  hold that plugin. Aliases map to package names, which is what the list holds. */
function listedAs(appDir: string, spec: string): string | undefined {
  const at = spec.lastIndexOf('@');
  const bare = at > 0 ? spec.slice(0, at) : spec;
  return pluginNames(appDir).find(entry => entry === spec || entry === bare);
}

export async function remove(args: string[], options: RemoveOptions, io: RemoveIo = defaultIo): Promise<void> {
  const flags = args.filter(arg => arg.startsWith('-'));
  if (flags.length) throw new Error(`Unknown remove flag: ${flags[0]}`);
  const name = args[0];
  if (!name) throw new Error('Remove what? aivi remove browser|discord|slack|linear|NPM-PACKAGE');
  const spec = PLUGIN_ALIASES[name] ?? name;
  if (spec === '@aivi/host' || spec === '@aivi/cli')
    throw new Error('The server and this CLI leave with `aivi uninstall`, not with remove.');
  const pkg = listedAs(options.appDir, spec);
  if (!pkg)
    throw new Error(
      `${name} is not in the plugin list (aivi-plugins in app/package.json); nothing to remove. \`aivi remove\` takes browser, discord, slack, linear or a listed package name.`,
    );

  // The block first, while the package can still say its module id; then the
  // entry, so no moment has a block listed to a plugin nobody imports; then
  // npm. A failing npm leaves the package installed but inert — out of the
  // list, its block gone — and says so.
  const { moduleId, blockRemoved } = await io.removeBlock(pkg, options);
  removePluginName(options.appDir, pkg);
  io.log(`${pkg} is out of the plugin list${blockRemoved ? ` and its plugins.${moduleId} block is gone` : ''}.`);
  try {
    io.uninstall(pkg, options.appDir);
  } catch (error) {
    io.warn(
      `${error instanceof Error ? error.message : String(error)} — the package stays under ${options.appDir}/node_modules, out of the list and inert; npm can remove the directory.`,
    );
  }

  // The editor schema drops the block's shape with the plugin; the truth of
  // the home is the list, so a cache that cannot rebuild is a warning.
  try {
    await io.rebuildSchema(options.home, options.appDir);
  } catch (error) {
    io.warn(
      `the editor schema was not rebuilt (${error instanceof Error ? error.message : String(error)}); \`aivi add\` or \`aivi update\` rebuilds it once config.json loads again.`,
    );
  }

  // No service, no restart: a foreground server is the operator's to stop and
  // start, and the module simply will not be there when it comes back.
  if (!io.service.installed()) {
    io.log(`${pkg} is removed. The next \`aivi serve\` will not run it.`);
    return;
  }
  const url = await io.healthUrl(options.home);
  io.log('Restarting aivi…');
  io.service.stop();
  io.service.start();
  await waitHealthy(io, url, 'aivi did not come back healthy within 30 s. Check `aivi service logs`.');
  io.log(`${pkg} is removed and aivi is back and healthy.`);
}
