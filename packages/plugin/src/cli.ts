/**
 * The operator-CLI contract an installable plugin package fills. Where
 * `./setup` is the install-time subpath, `./cli` is the runtime one: a
 * package that default-exports a factory `(ctx) => Command` from its `./cli`
 * subpath has its command subtree mounted into the server CLI whenever the
 * package is installed. The factory builds real commander — parsing, help,
 * choices and variadics are commander's own, and the plugin declares
 * `commander` itself — while `ctx` carries everything the plugin cannot
 * know: the home, the store door, the host poke and the streams. The
 * contract stays testable without a terminal.
 */

import type { LoadedConfig, OutputBlock } from '@aivi/core';
import type { ConversationStore, Store } from '@aivi/host';
import type * as prompts from '@clack/prompts';

/** What the machine this CLI runs on *is*: the one fact that decides command
 *  membership. `home` is the aivi home this machine has, or absent when it has
 *  none. The CLI resolves it once per run (AIVI_HOME, then the client record)
 *  and hands it to every command provider; a provider that cannot run without
 *  a home simply does not register the command — membership is decided by the
 *  provider at mount time, never by hiding a command after the fact. */
export interface MachineStatus {
  home?: string | undefined;
  /** The client record's path when this machine has one — the file `configure`
   *  edits (where the host is, who signs in). The command exists only where
   *  the file exists; `setup` creates the first one. Existence, not
   *  parseability: a broken record is exactly what `configure` is for. */
  clientConfig?: string | undefined;
  /** True when this process is the far end of an exec session: the host
   *  spawned it (`AIVI_EXEC_SESSION`) to run commands someone typed on
   *  another machine. Providers decide from it — the plan's sets are carried
   *  by the commands' own declarations, not by the channel: commands that
   *  act on the machine you type on answer their guard line here, and
   *  commands that would fight the session itself refuse theirs. */
  remote?: boolean | undefined;
}

/** What the CLI hands a plugin's command factory: the same home the built-ins
 *  see, the same stdout contract, and nothing platform-specific. */
export interface PluginCliContext {
  /** The machine's state, for commands that decide whether to exist here. */
  machine: MachineStatus;
  /** The aivi home that owns `config.json` and `.env`. */
  home: string;
  configPath: string;
  /** The loaded, validated config; a command reads its own module block from it. */
  loaded(): Promise<LoadedConfig>;
  /** The home's SQLite store, open for the callback and closed after. */
  withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T>;
  /** The record on stdout — JSON whenever stdout is a pipe; on a terminal the
   *  optional `output` renders as readable blocks (core's `print`). */
  print(value: unknown, output?: OutputBlock[] | string): void;
  /** A note on stderr: what was saved, what to restart, what survived. */
  log(message: string): void;
  /** Wake the running host so saved work dispatches without waiting. */
  poke(): Promise<void>;
  /** The very `@clack/prompts` module the runner renders with. One rule
   *  across both plugin contracts: the runner hands its own module instance;
   *  whoever is called owns the screen (two clacks animating one terminal
   *  mangle each other), so a command opens one animation at a time and
   *  settles it before returning. */
  prompts: typeof prompts;
}

/**
 * Open the module's own conversation store against the home store, release the
 * blocked record, print the receipt, and wake the host so the freed worker
 * dispatches without waiting. Every channel's `resolve` command ends with this
 * exact sequence; keeping it in one place is what stops the poke from being
 * dropped or the receipt from drifting when the contract changes. `openStore`
 * supplies the module-specific store (it may close over the module's config).
 */
export async function resolveBlocked(
  ctx: PluginCliContext,
  id: string | undefined,
  reason: unknown,
  openStore: (store: Store) => ConversationStore,
): Promise<void> {
  await ctx.withStore(store => {
    openStore(store).resolve(String(id), String(reason));
    ctx.print({ resolved: true });
  });
  await ctx.poke();
}
