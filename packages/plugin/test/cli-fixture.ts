import type { LoadedConfig } from '@aivi/core';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import type { PluginCliContext } from '../src/cli.ts';
import type { Store } from '../src/module.ts';

/** What a home holds for a plugin command: the plugin blocks of its config,
 *  where its state lives, the persona's name, its open store, and what its
 *  host does on a poke. `prompts` stands in for the runner's clack: a test
 *  that leaves it out gets clack itself. */
export interface CliHome {
  plugins?: Record<string, unknown>;
  stateDirectory?: string;
  identityName?: string;
  store?: Store;
  onPoke?: () => void;
  prompts?: PluginCliContext['prompts'];
}

/**
 * A plugin's commands, played against a recorded context. `run` builds the
 * plugin's own commander subtree and parses one command line, as the mount
 * does; `printed` holds each record a command printed and `said` the words
 * that went with it.
 */
export function cliFixture(factory: (ctx: PluginCliContext) => Command | Promise<Command>, home: CliHome = {}) {
  const printed: unknown[] = [];
  const said: unknown[] = [];
  let pokes = 0;
  const ctx: PluginCliContext = {
    machine: { home: '/home', clientConfig: '/home/.config/aivi/config.json' },
    home: '/home',
    configPath: '/home/config.json',
    loaded: async () =>
      ({
        config: {
          plugins: home.plugins ?? {},
          stateDirectory: home.stateDirectory,
          identity: { name: home.identityName ?? 'aivi' },
        },
      }) as unknown as LoadedConfig,
    withStore: async fn => fn(home.store as Store),
    print: (value, output) => {
      printed.push(value);
      said.push(output);
    },
    log: () => {},
    poke: async () => {
      pokes += 1;
      home.onPoke?.();
    },
    prompts: home.prompts ?? prompts,
  };
  return {
    printed,
    said,
    pokes: () => pokes,
    run: async (...line: string[]) => {
      await (await factory(ctx)).parseAsync(line, { from: 'user' });
    },
  };
}
