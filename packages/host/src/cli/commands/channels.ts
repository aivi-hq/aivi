/** Plugin commands live in their packages: every package the `aivi-plugins` list
 *  in app/package.json names is asked for its `./cli` subpath (@aivi/plugin's
 *  `(ctx) => Command` factory), and whatever answers is mounted into the tree —
 *  the factory builds real commander, so parsing and help are its own, and the
 *  package owns the words and the work. The list is the whole mapping: no
 *  hardcoded table, nothing scans node_modules, and a package installed but not
 *  listed stays out of the help. A listed package without a `./cli` export is
 *  simply absent from the help, like a plugin that configures nothing. */

import type { LoadedConfig } from '@aivi/core';
import { errorMessage } from '@aivi/core';
import type { Store } from '@aivi/host';
import type { PluginCliContext } from '@aivi/plugin';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { configPath, context, home, print, withStore } from '../context.ts';
import type { PluginEntry } from '../registry.ts';
import { pluginRegistry } from '../registry.ts';

/** The capabilities the CLI lends a plugin's commands: its own context and
 *  store bracket, the shared streams, the host poke, and the very clack the
 *  built-ins render with — whoever is called owns the screen. */
function pluginCliContext(): PluginCliContext {
  return {
    home,
    configPath,
    loaded: async (): Promise<LoadedConfig> => (await context()).loaded,
    withStore: async <T>(fn: (store: Store) => T | Promise<T>) => withStore((await context()).loaded, fn),
    print,
    log: message => console.error(message),
    poke: async () => {
      await (await context()).poke();
    },
    prompts: p,
  };
}

/** Ask every listed package for its command factory; the ones that answer join
 *  the tree. A list that cannot load (a package npm does not hold) is printed as
 *  a note here — `--help` keeps working, and the commands that need the config
 *  fail with the registry's own named fix. */
export async function registerChannels(program: Command): Promise<void> {
  let entries: PluginEntry[];
  try {
    entries = (await pluginRegistry(home)).entries;
  } catch (error) {
    console.error(`aivi: the plugin list did not load (${errorMessage(error)}); plugin commands are absent.`);
    return;
  }
  for (const entry of entries) {
    let factory: unknown;
    try {
      factory = ((await import(`${entry.name}/cli`)) as { default?: unknown }).default;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // No ./cli export — a plugin with no operator commands (the browser): nothing to mount.
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;
      console.error(`aivi: ${entry.name}/cli did not load (${errorMessage(error)}); its commands are absent.`);
      continue;
    }
    if (typeof factory !== 'function') {
      console.error(`aivi: ${entry.name}/cli exports no command; its commands are absent.`);
      continue;
    }
    // The package is the whole boundary: its subtree is mounted as it stands, and
    // only the name collision with a built-in would be refused, which none has.
    const command = await (factory as (ctx: PluginCliContext) => Promise<Command> | Command)(pluginCliContext());
    if (!command.helpGroup()) command.helpGroup('Plugins');
    program.addCommand(command);
  }
}
