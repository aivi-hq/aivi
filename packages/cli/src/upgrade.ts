/** `aivi upgrade` — update this CLI through the way it was installed. The probe
 *  and the command are the install-method table's, the same row `aivi uninstall`
 *  reads, so the two can never disagree about what is installed. */

import { detectInstallMethod, runInstallMethod } from './install-method.ts';

export function upgradeCli(): void {
  const method = detectInstallMethod();
  if (!method)
    throw new Error('This CLI was not installed with a method aivi knows; update it the way you installed it.');
  runInstallMethod(method, 'update');
}
