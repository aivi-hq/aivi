/** The safe writes behind every command that changes `config.json` or `.env`.
 *  One named block is written and nothing else is touched; the whole file must
 *  load again afterwards, and a write that does not validate is restored to
 *  its previous bytes. `writeProjectLinear` carries the same guarantee for its
 *  one block; these are the general shape of it. */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadConfig } from './config.ts';

/**
 * Write one block into `config.json` at a path like `['modules', 'discord']`:
 * only that path is created or replaced, everything else keeps its bytes, and
 * the result must load with `loadConfig` — otherwise the old file returns and
 * the validation error stands.
 */
export async function writeConfigBlock(configPath: string, path: string[], value: unknown): Promise<void> {
  if (!path.length || path.some(step => !step)) throw new Error('writeConfigBlock needs a path of key segments');
  const before = readFileSync(configPath, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  let node = raw;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path.at(-1)!] = value;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    await loadConfig(configPath);
  } catch (error) {
    writeFileSync(configPath, before);
    throw error;
  }
}

/**
 * Set one key in a dotenv-style secrets file: replace its line in place, or
 * append it when absent. The value is never echoed, and the file is kept
 * owner-only (0600) — a secret must not sit world-readable after a write.
 */
export function upsertEnvFile(path: string, key: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Not an environment variable name: ${key}`);
  const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const pad = body && !body.endsWith('\n') ? '\n' : '';
  const next = pattern.test(body) ? body.replace(pattern, () => line) : `${body}${pad}${line}\n`;
  writeFileSync(path, next);
  chmodSync(path, 0o600);
}

/** The names a dotenv file defines; everything in it is treated as a secret. */
export function envFileKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  return Object.keys(parseEnv(readFileSync(path, 'utf8')));
}
