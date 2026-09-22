/** How this CLI can have been installed, in one table. `aivi upgrade` and
 *  `aivi uninstall` read the same entry: what counts as installed, how it is
 *  updated and how it goes away can never disagree. A method is one row —
 *  probe, update, uninstall. npm is the only method today; brew, bun or a curl
 *  script would each add one. */

import { spawnSync } from 'node:child_process';

export const CLI_PACKAGE = '@aivi/cli';

interface Method {
  /** The program that manages this install. */
  readonly bin: string;
  /** Asks for the global list; the answer names the CLI when it is in. */
  readonly probe: readonly string[];
  readonly marker: string;
  readonly update: readonly string[];
  readonly uninstall: readonly string[];
}

export const INSTALL_METHODS = {
  npm: {
    bin: 'npm',
    probe: ['list', '-g', CLI_PACKAGE, '--depth=0'],
    marker: `${CLI_PACKAGE}@`,
    update: ['install', '-g', `${CLI_PACKAGE}@latest`],
    uninstall: ['uninstall', '-g', CLI_PACKAGE],
  },
} as const satisfies Record<string, Method>;

export type InstallMethod = keyof typeof INSTALL_METHODS;
export type MethodAction = 'update' | 'uninstall';

/** The method whose probe answers, or undefined when the CLI came from
 *  somewhere aivi does not know how to ask. */
export function detectInstallMethod(): InstallMethod | undefined {
  for (const [method, spec] of Object.entries(INSTALL_METHODS) as [InstallMethod, Method][]) {
    const probe = spawnSync(spec.bin, spec.probe, { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout?.includes(spec.marker)) return method;
  }
  return undefined;
}

/** Run one method's command in the person's terminal; throws naming it. */
export function runInstallMethod(method: InstallMethod, action: MethodAction): void {
  const spec = INSTALL_METHODS[method];
  const result = spawnSync(spec.bin, spec[action], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${spec.bin} ${[...spec[action]].join(' ')} failed (exit ${result.status ?? 'signal'})`);
}
