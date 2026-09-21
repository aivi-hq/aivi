/** The one file the CLI owns: `~/.config/aivi.json` (or `$XDG_CONFIG_HOME/aivi.json`),
 *  0600, never hand-edited. It merges the client record — where the host is, which
 *  person signs in — with the installation record aivi writes at `server create`:
 *  the home, the selected Node, the app directory, the install method. Unknown
 *  fields survive a save so the file can grow without a migration. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const clientConfigSchema = z
  .object({
    configVersion: z.literal(1),
    url: z.string().min(1).optional(),
    home: z.string().min(1).optional(),
    person: z.object({ token: z.string().min(1) }).optional(),
    nodePath: z.string().min(1).optional(),
    appDir: z.string().min(1).optional(),
    installMethod: z.enum(['npm', 'bun', 'brew', 'curl']).optional(),
  })
  .loose();

export type ClientConfig = z.infer<typeof clientConfigSchema>;

export function clientConfigPath(): string {
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'aivi.json');
}

export function loadClientConfig(): ClientConfig | undefined {
  const path = clientConfigPath();
  if (!existsSync(path)) return undefined;
  return clientConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Merge-save: unknown fields and the signed-in person survive; 0600 stays 0600. */
export function saveClientConfig(update: Partial<ClientConfig>): ClientConfig {
  const path = clientConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? clientConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : {};
  const next: ClientConfig = { ...current, ...update, configVersion: 1 };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return next;
}
