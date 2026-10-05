/** Where the client record lives — the one file `aivi setup` signs this
 *  machine into a host with, holding where the host answers, which person
 *  signs in, and how the server was installed. The path is a shared fact:
 *  the host signs it, the OpenCode plugin reads credentials from it, and
 *  every command takes hints from it. `@aivi/cli` computes the same path
 *  itself (cli/client-config.ts): the CLI may not import core — the
 *  packaging test is that wall — so this is the one copy the host side gets. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** `~/.config/aivi/config.json`, or `$XDG_CONFIG_HOME/aivi/config.json`, or
 *  the file `AIVI_CONFIG` names — a development home signs its own copy.
 *  Read at call, not frozen at import: the env names the file, and a
 *  module-level constant would pin the process to whatever env the first
 *  importer had. */
export function clientConfigPath(env: Record<string, string | undefined> = process.env): string {
  if (env.AIVI_CONFIG) return resolve(env.AIVI_CONFIG);
  return resolve(env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'aivi', 'config.json');
}
