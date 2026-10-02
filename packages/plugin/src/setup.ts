/**
 * The install contract an installable plugin package fills. `aivi add`
 * npm-installs the package into the server home and then runs its `./setup`
 * entry; the CLI knows nothing platform-specific. Everything the flow needs
 * arrives through the context, so the flow prints its own platform
 * instructions and is testable without a terminal or a platform account.
 */

import type { OutputBlock } from '@aivi/core';
import type * as prompts from '@clack/prompts';
import type { Store } from './module.ts';

/** A prompt the person cancelled; the runner says it stopped and writes nothing further. */
export class PluginSetupCancelled extends Error {}

export interface PluginSetupContext {
  /** The aivi home that owns `config.json` and `.env`. */
  home: string;
  configPath: string;
  /** The persona from config.json `identity.name` — what the bot is called on the platform. */
  identityName: string;
  /** The raw parsed `config.json`, so a flow can see what is already configured. */
  config: Record<string, unknown>;
  /** The command output record on stdout: raw JSON text on the terminal when the
   *  value is for copying (core's `print`), so paste-able output stays paste-able. */
  print(value: unknown, output?: OutputBlock[] | string): void;
  /** The very `@clack/prompts` module the runner renders with, handed over
   *  so a flow draws all its own lines — notes, log lines, prompts,
   *  spinners — with the same instance and style as the runner's intro and
   *  cancel line. Whoever is called owns the screen: two clacks animating
   *  one terminal mangle each other (measured 2026-09-27), so a flow opens
   *  one animation at a time, prints nothing beside it, and settles it
   *  before returning or throwing. A prompt cancelled on Ctrl+C is no
   *  answer: the flow throws `PluginSetupCancelled` and nothing further
   *  is written. */
  prompts: typeof prompts;
  /** Platform calls the flow verifies with; the runner supplies the real fetch. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The home's SQLite store, open for the callback and closed after, whatever
   *  the callback does. A flow reads what the server has recorded (a webhook's
   *  diary) without importing the server: `Store` is named here as a type, the
   *  runner opens the database. */
  withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T>;
  /** Write this plugin's block into `config.json`; the file must load again or the old bytes return. */
  writeConfigBlock(path: string[], value: unknown): Promise<void>;
  /** Replace-or-append one key in `<home>/.env`, kept 0600; the value is never echoed. */
  writeSecret(key: string, value: string): Promise<void>;
}

export interface PluginSetupResult {
  /** The module the flow enabled — the id `aivi add` watches in `/status`. */
  module: string;
  /** The verified last line: what is true now, never what may happen. */
  summary: string;
}

/** Every plugin's `./setup` entry: one default-exported function. */
export type PluginSetup = (ctx: PluginSetupContext) => Promise<PluginSetupResult>;
