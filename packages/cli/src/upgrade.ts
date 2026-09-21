/** `aivi upgrade` — update this CLI through the way it was installed. Only npm
 *  exists today: probe the global list, and when the CLI shows up there,
 *  install the newest release. Other methods (brew, bun, a curl script) hook
 *  into the same probe later. */
import { spawnSync } from 'node:child_process';

export function upgradeCli(): void {
  const list = spawnSync('npm', ['list', '-g', '@aivi/cli', '--depth=0'], { encoding: 'utf8' });
  if (list.status !== 0 || !list.stdout.includes('@aivi/cli@'))
    throw new Error('This CLI was not installed with npm; update it the way you installed it.');
  const install = spawnSync('npm', ['install', '-g', '@aivi/cli@latest'], { stdio: 'inherit' });
  if (install.status !== 0)
    throw new Error(`npm install -g @aivi/cli@latest failed (exit ${install.status ?? 'signal'})`);
}
