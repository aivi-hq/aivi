/** Which home aivi works on. `AIVI_HOME` leads (it is how development and tests
 *  point at a scratch home); otherwise the `home` field of the CLI-owned
 *  `~/.config/aivi.json`, which `aivi setup` writes. For setup itself the
 *  chain ends at the default `~/.aivi`. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { clientConfigPath, loadClientConfig } from './client-config.ts';

export function homeFromEnvOrConfig(): string | undefined {
  if (process.env.AIVI_HOME) return resolve(process.env.AIVI_HOME);
  // A record that does not load names no home: the machine is homeless for
  // membership, and the record's own existence still registers `configure`
  // — a broken record is exactly what that command is for.
  return loadClientConfig()?.home;
}

export function homeForCreate(): string {
  return homeFromEnvOrConfig() ?? join(homedir(), '.aivi');
}

/** The machine's facts, decided once per run from the environment and no
 *  probe: this machine has a home or it has none (`AIVI_HOME`, then the
 *  client record), it has a client record or it does not, and this process
 *  is driven remotely or it isn't (`AIVI_EXEC_SESSION`, set by the exec
 *  door's closed env). It is structurally the `MachineStatus` of
 *  `@aivi/plugin` (the command-provider contract); `@aivi/cli` restates it
 *  because it may import nothing outside its own dependencies (the packaging
 *  test is that gate). Providers receive it and decide from it: what cannot
 *  run here is never registered, and a command the channel must not run
 *  answers its own guard line. */
export interface MachineStatus {
  home?: string | undefined;
  /** The client record's path when this machine has one — where the host
   *  is and who signs in. It decides one membership: `configure` edits
   *  that file, so the command exists only where a file exists; `setup`
   *  creates the first one. Existence, not parseability: a broken record
   *  is exactly what `configure` is for. */
  clientConfig?: string | undefined;
  /** True when this process is the far end of an exec session: the host
   *  spawned it to run commands someone typed on another machine. */
  remote?: boolean | undefined;
}

export function machineStatus(): MachineStatus {
  const home = homeFromEnvOrConfig();
  const clientConfig = clientConfigPath();
  return {
    ...(home === undefined ? {} : { home }),
    ...(existsSync(clientConfig) ? { clientConfig } : {}),
    ...(process.env.AIVI_EXEC_SESSION === '1' ? { remote: true } : {}),
  };
}

export function requireHome(): string {
  const home = homeFromEnvOrConfig();
  if (!home) throw new Error('No aivi home known. Run `aivi setup`, or set AIVI_HOME.');
  return home;
}
