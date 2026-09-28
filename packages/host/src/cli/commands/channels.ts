/** Channel commands live in their packages: each installable module's package is
 *  asked for its `./cli` subpath (@aivi/plugin's `(ctx) => Command` factory), and
 *  whatever answers is mounted into the tree — the factory builds real commander,
 *  so parsing and help are its own, and the package owns the words and the work.
 *  The mapping is the same bounded, config-driven one the host uses; nothing
 *  scans node_modules. A package that is not installed is simply absent from the
 *  help, like a module that is not configured. */

import type { LoadedConfig } from '@aivi/core';
import { errorMessage } from '@aivi/core';
import type { Store } from '@aivi/host';
import type { PluginCliContext } from '@aivi/plugin';
import * as p from '@clack/prompts';
import type { Command } from 'commander';
import { configPath, context, home, print, withStore } from '../context.ts';

/** The module id → package spec mapping, the one the host and the installer keep too. */
const MODULE_SPECS: Record<string, string> = {
  discord: '@aivi/channel-discord',
  slack: '@aivi/channel-slack',
  linear: '@aivi/tracker-linear',
};

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

/** Ask every mapped package for its command factory; the ones that answer join the tree. */
export async function registerChannels(program: Command): Promise<void> {
  for (const [, spec] of Object.entries(MODULE_SPECS)) {
    let factory: unknown;
    try {
      factory = ((await import(`${spec}/cli`)) as { default?: unknown }).default;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Not installed, or installed without a ./cli export: no commands to mount.
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue;
      console.error(`aivi: ${spec}/cli did not load (${errorMessage(error)}); its commands are absent.`);
      continue;
    }
    if (typeof factory !== 'function') {
      console.error(`aivi: ${spec}/cli exports no command; its commands are absent.`);
      continue;
    }
    // The package is the whole boundary: its subtree is mounted as it stands, and
    // only the name collision with a built-in would be refused, which none has.
    const command = await (factory as (ctx: PluginCliContext) => Promise<Command> | Command)(pluginCliContext());
    if (!command.helpGroup()) command.helpGroup('Channels');
    program.addCommand(command);
  }
}
