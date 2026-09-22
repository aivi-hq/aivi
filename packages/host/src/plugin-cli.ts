/**
 * The operator-CLI contract an installable plugin package fills. Where
 * `./setup` (in @aivi/core) is the install-time subpath, `./cli` is the
 * runtime one: a package that default-exports a `PluginCliCommand` from its
 * `./cli` subpath has its command mounted into the server CLI, grouped under
 * Channels, whenever the package is installed. The command is data — the
 * app's commander owns parsing and help — and `run` receives the context:
 * the loaded config, the store, the host poke and the streams, so the plugin
 * never imports app code and the contract stays testable without a terminal.
 */

/** One option of a plugin CLI subcommand, in the shape the app translates. */
export interface PluginCliOption {
  /** The option's flags, e.g. `--reason <text>` or `--confirm-stopped`. */
  flags: string;
  description: string;
  /** Refuse to run without it. */
  required?: boolean;
  /** Collect repeats into a list instead of keeping the last value. */
  multiple?: boolean;
  /** The value when the command runs without the option. */
  default?: string | boolean;
}

/** One subcommand a plugin offers (`discord register`, `discord status`, …). */
export interface PluginCliSubcommand {
  name: string;
  description: string;
  /** The argument string, e.g. `<id>` or `[url]`; no arguments when absent. */
  args?: string;
  options?: PluginCliOption[];
  run(ctx: PluginCliContext, args: string[], options: Record<string, unknown>): Promise<void>;
}

/** The whole command a plugin adds: one top-level name with subcommands. */
export interface PluginCliCommand {
  name: string;
  description: string;
  /** The help group the command lists under; Channels by default. */
  helpGroup?: string;
  subcommands: PluginCliSubcommand[];
}

import type { LoadedConfig } from '@aivi/core';
import type { Store } from './store.ts';

/** What the app hands a plugin's CLI commands: the same home the built-ins
 *  see, the same JSON stdout contract, and nothing platform-specific. */
export interface PluginCliContext {
  /** The aivi home that owns `config.json` and `.env`. */
  home: string;
  configPath: string;
  /** The loaded, validated config; a command reads its own module block from it. */
  loaded(): Promise<LoadedConfig>;
  /** The home's SQLite store, open for the callback and closed after. */
  withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T>;
  /** The JSON record on stdout — the machine-readable output every command shares. */
  print(value: unknown): void;
  /** A note on stderr: what was saved, what to restart, what survived. */
  log(message: string): void;
  /** Wake the running host so saved work dispatches without waiting. */
  poke(): Promise<void>;
  ask: {
    /** One line of text, or undefined when the person cancelled. */
    text(options: {
      message: string;
      placeholder?: string | undefined;
      validate?: (value: string) => string | undefined;
    }): Promise<string | undefined>;
  };
}
