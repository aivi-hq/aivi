/** The one edge where the thin CLI reaches into the installed app: a dynamic
 *  import of a module under `<appDir>/node_modules/@aivi/app/dist`, never a
 *  static one. Machine commands import nothing from here unless the operator
 *  command they are about to run is the app's, so a half-installed or broken
 *  app can always be repaired by `aivi update` and the service commands.
 *  Before any import the CLI puts its own resolved home in `AIVI_HOME`, the
 *  way the spawn relay used to; the app's context then reads that home. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';
import { loadClientConfig } from './client-config.ts';
import { requireHome } from './home.ts';

function appPackageDir(appDir: string): string {
  return join(appDir, 'node_modules', '@aivi', 'app');
}

/** Import one module of the installed app. `modulePath` is relative to the
 *  package root, like `dist/identity.js`. */
export async function importApp<T>(appDir: string, home: string, modulePath: string): Promise<T> {
  const root = appPackageDir(appDir);
  if (!existsSync(root)) throw new Error(`No aivi server installed at ${appDir}. Run \`aivi setup\` first.`);
  process.env.AIVI_HOME = home;
  return import(pathToFileURL(join(root, modulePath)).href) as Promise<T>;
}

/** The app's own appDir: the install record's, else `<home>/app`. */
export function appDirFor(home: string): string {
  return loadClientConfig()?.appDir ?? join(home, 'app');
}

/** Mount the installed app's operator commands onto this CLI's tree. The
 *  import is lazy by the caller's choice: only a request that is not a
 *  machine command gets here. */
export async function mountAppCommands(program: Command): Promise<void> {
  const home = requireHome();
  const { registerCommands } = await importApp<{
    registerCommands: (program: Command) => Promise<void>;
  }>(appDirFor(home), home, 'dist/cli.js');
  await registerCommands(program);
}
