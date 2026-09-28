/** Which home aivi works on. `AIVI_HOME` leads (it is how development and tests
 *  point at a scratch home); otherwise the `home` field of the CLI-owned
 *  `~/.config/aivi.json`, which `aivi setup` writes. For setup itself the
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

/** The machine's one fact, decided once per run from exactly two things —
 *  AIVI_HOME and the client record — with no network probe: this machine has
 *  a home, or it has none. It is structurally the `MachineStatus` of
 *  `@aivi/plugin` (the command-provider contract); `@aivi/cli` restates it
 *  because it may import nothing outside its own dependencies (the packaging
 *  test is that gate). Providers receive it and decide membership themselves:
 *  what cannot run here is never registered, never hidden after the fact. */
export interface MachineStatus {
  home?: string | undefined;
}

export function machineStatus(): MachineStatus {
  const home = homeFromEnvOrConfig();
  return home === undefined ? {} : { home };
}

export function requireHome(): string {
  const home = homeFromEnvOrConfig();
  if (!home) throw new Error('No aivi home known. Run `aivi setup`, or set AIVI_HOME.');
  return home;
}
