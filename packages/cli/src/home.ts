/** Which home aivi works on. `AIVI_HOME` leads (it is how development and tests
 *  point at a scratch home); otherwise the `home` field of the CLI-owned
 *  `~/.config/aivi.json`, which `server create` writes. For create itself the
 *  chain ends at the default `~/.aivi`. */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadClientConfig } from './client-config.ts';

export function homeFromEnvOrConfig(): string | undefined {
  if (process.env.AIVI_HOME) return resolve(process.env.AIVI_HOME);
  return loadClientConfig()?.home;
}

export function homeForCreate(): string {
  return homeFromEnvOrConfig() ?? join(homedir(), '.aivi');
}

export function requireHome(): string {
  const home = homeFromEnvOrConfig();
  if (!home) throw new Error('No aivi home known. Run `aivi server create`, or set AIVI_HOME.');
  return home;
}
