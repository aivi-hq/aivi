/** Every command the thin CLI does not own runs in the *installed* app: the CLI
 *  spawns `<app>/node_modules/@aivi/app/dist/cli.js` with the same arguments and
 *  `AIVI_HOME` in the environment, and exits with its status. The CLI itself
 *  never imports host code — before an installation exists there is nothing to
 *  run, and the error says so. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function appCliPath(appDir: string): string {
  const path = join(appDir, 'node_modules', '@aivi', 'app', 'dist', 'cli.js');
  if (!existsSync(path)) throw new Error(`No aivi server installed at ${appDir}. Run \`aivi setup\` first.`);
  return path;
}

export function forward(
  args: string[],
  options: { home: string; appDir: string; nodePath?: string | undefined },
): number {
  const { home, appDir } = options;
  const nodePath = options.nodePath ?? process.execPath;
  const result = spawnSync(nodePath, [appCliPath(appDir), ...args], {
    stdio: 'inherit',
    env: { ...process.env, AIVI_HOME: home },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
