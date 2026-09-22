/** Shared plumbing for every command: the home, the lazily-loaded context
 *  (config, .env, a logger, the host poke), the store bracket and the small
 *  helpers the actions share. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { LoadedConfig, Logger } from '@aivi/core';
import { errorMessage, getLogger, loadConfig } from '@aivi/core';
import { createHostClient, Store } from '@aivi/host';

/** One home holds everything: config.json, .env, state/. Paths in the config resolve against it. */
export const home = resolve(process.env.AIVI_HOME ?? resolve(homedir(), '.aivi'));
export const configPath = resolve(home, 'config.json');

let contextPromise:
  | Promise<{ loaded: LoadedConfig; protectedEnv: string[]; log: Logger; poke: () => Promise<void> }>
  | undefined;

/** Everything an action needs from the home, loaded once, lazily: logging is
 *  configured by the preAction hook in cli.ts, so an action that asks for the
 *  context gets a ready log. `server create` runs before any config exists and
 *  never asks for the context. */
export const context = () =>
  (contextPromise ??= (async () => {
    if (!existsSync(configPath))
      throw new Error(`No config.json in ${home}. Create one, or point AIVI_HOME at a directory that has one.`);
    const log = getLogger(['aivi']);
    // .env is loaded without overriding existing variables, so `fnox exec` and CI overrides behave.
    const protectedEnv = loadEnvFile(resolve(home, '.env'), log);
    const loaded = await loadConfig(configPath);
    // The CLI writes to SQLite directly; the running host learns about it through this poke and
    // nothing else, so a poke that cannot be delivered is said out loud rather than swallowed.
    const poke = async () => {
      await createHostClient(hostUrl(loaded))
        .wake()
        .catch(error =>
          console.error(
            `Note: could not wake the host (${errorMessage(error)}). Saved; it takes effect when the host next dispatches (a due job, or \`aivi serve\` starting).`,
          ),
        );
    };
    return { loaded, protectedEnv, log, poke };
  })());

export const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** Repeatable options collect into a list: `--lane Dev:dev --lane Review:dev`. */
export const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** The home's SQLite store, open for the callback and closed after, whatever
 *  the callback does. Commands that need no database never touch one. */
export async function withStore<T>(loaded: LoadedConfig, fn: (store: Store) => T | Promise<T>): Promise<T> {
  const store = new Store(resolve(loaded.config.stateDirectory, 'aivi.sqlite'));
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * dotenv-style file; existing environment always wins, so `fnox exec` and CI overrides behave.
 * Returns the variable names the file defines: everything in it is treated as a secret.
 */
function loadEnvFile(path: string, log: { debug(event: string, fields?: Record<string, unknown>): void }): string[] {
  if (!existsSync(path)) return [];
  process.loadEnvFile(path);
  log.debug('env.loaded', { path });
  return Object.keys(parseEnv(readFileSync(path, 'utf8')));
}

export function hostUrl(loaded: LoadedConfig): string {
  const { bind, port } = loaded.config.host;
  const host = ['0.0.0.0', '::', '[::]'].includes(bind) ? '127.0.0.1' : bind;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
