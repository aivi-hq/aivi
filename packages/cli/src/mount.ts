/** The one edge where the thin CLI reaches into the installed server: a
 *  dynamic import of a module under `<appDir>/node_modules/@aivi/host/dist`,
 *  never a static one. Machine commands import nothing from here unless the
 *  operator command they are about to run is the server's, so a half-installed
 *  or broken server install can always be repaired by `aivi update` and the
 *  service commands. Before any import the CLI puts its own resolved home in
 *  `AIVI_HOME`, the way the spawn relay used to; the host's cli context then
 *  reads that home. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';
import { loadClientConfig } from './client-config.ts';
import { requireHome } from './home.ts';

function hostPackageDir(appDir: string): string {
  return join(appDir, 'node_modules', '@aivi', 'host');
}

/** Import one module of the installed server. `modulePath` is relative to the
 *  package root, like `dist/cli/identity.js`. */
export async function importApp<T>(appDir: string, home: string, modulePath: string): Promise<T> {
  const root = hostPackageDir(appDir);
  if (!existsSync(root)) throw new Error(`No aivi server installed at ${appDir}. Run \`aivi setup\` first.`);
  process.env.AIVI_HOME = home;
  return import(pathToFileURL(join(root, modulePath)).href) as Promise<T>;
}

/** The installed server's appDir: the install record's, else `<home>/app`. */
export function appDirFor(home: string): string {
  return loadClientConfig()?.appDir ?? join(home, 'app');
}

/** Mount the installed server's operator commands onto this CLI's tree. The
 *  import is lazy by the caller's choice: only a request that is not a
 *  machine command gets here. */
export async function mountAppCommands(program: Command): Promise<void> {
  const home = requireHome();
  const { registerCommands } = await importApp<{
    registerCommands: (program: Command) => Promise<void>;
  }>(appDirFor(home), home, 'dist/cli.js');
  await registerCommands(program);
}
