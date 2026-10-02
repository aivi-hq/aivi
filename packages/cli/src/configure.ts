/** `aivi configure` — edit the client record this machine already has: where
 *  the host answers, where the home is, which directory holds the installed
 *  server. `aivi setup` creates that record; this is the only other writer,
 *  and it never touches the signed-in person — the token is audit evidence,
 *  and the most a person can become is *disabled*, a server-side people
 *  decision ([people.md](../../../../docs/people.md)), not a laptop
 *  command's feature. A broken record is exactly what this command is for:
 *  its membership rode the file's existence, not its parseability, and the
 *  edit writes the record fresh around every field that still reads as
 *  JSON — the person block only when its token survives, because a record
 *  this command writes has to load again. Plain bytes and no network: the
 *  command edits a file and prints it, and never probes the host it was
 *  just pointed at. */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ClientConfig, clientConfigPath, clientConfigSchema } from './client-config.ts';

export interface ConfigureEdits {
  url?: string | undefined;
  home?: string | undefined;
  appDir?: string | undefined;
}

const INSTALL_METHODS = ['npm', 'bun', 'brew', 'curl'] as const;

/** The record, printed: the human-facing fields, and never the token — the
 *  view says *that* someone is signed in, which is a fact; what signs is
 *  not. */
function printRecord(record: ClientConfig): void {
  const person = record.person;
  const who = person ? (person.name ?? person.id ?? 'unnamed') : 'nobody signed in';
  const roles = person?.roles?.length ? ` (${person.roles.join(', ')})` : '';
  process.stdout.write(
    [
      `host:    ${record.url ?? 'not set'}`,
      `home:    ${record.home ?? 'not set (this machine drives another host)'}`,
      `app dir: ${record.appDir ?? 'not set'}`,
      `person:  ${who}${roles}`,
    ].join('\n') + '\n',
  );
}

function checkedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`not an http(s) URL: ${value}`);
  return value;
}

/** A path edit lands as an absolute path that is a directory now: pointing
 *  the record at a home that does not exist would write a broken machine,
 *  and the record's own existence rule cuts the other way here. */
function checkedDir(label: string, value: string): string {
  const path = resolve(value);
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`no ${label} directory at ${path}`);
  return path;
}

/** Carry every field of the old record that still reads as JSON, so the
 *  person, the selected Node and the install method survive an edit of an
 *  unloadable file; drop what the schema would only reject. The person
 *  block lives or dies by its token — audit evidence is kept when it is
 *  still itself, and never invented. */
function rescue(parsed: Record<string, unknown>): Record<string, unknown> {
  const base = { ...parsed };
  for (const key of ['url', 'home', 'appDir', 'nodePath'] as const)
    if (typeof base[key] !== 'string' || base[key] === '') delete base[key];
  if (!INSTALL_METHODS.includes(base.installMethod as (typeof INSTALL_METHODS)[number])) delete base.installMethod;
  const person = base.person;
  delete base.person;
  if (person === null || typeof person !== 'object' || Array.isArray(person)) return base;
  const p = person as Record<string, unknown>;
  if (typeof p.token !== 'string' || p.token === '') return base;
  const kept: Record<string, unknown> = { token: p.token };
  for (const key of ['id', 'name'] as const) if (typeof p[key] === 'string' && p[key] !== '') kept[key] = p[key];
  if (Array.isArray(p.roles) && p.roles.every(role => typeof role === 'string')) kept.roles = p.roles;
  base.person = kept;
  return base;
}

export function configure(edits: ConfigureEdits): void {
  const path = clientConfigPath();
  if (!existsSync(path)) throw new Error(`no client record at ${path}; \`aivi setup\` creates one`);
  if (edits.url === undefined && edits.home === undefined && edits.appDir === undefined) {
    // The view reads and writes nothing: showing a record is no reason to
    // rewrite it. A record that does not load says so, and says which
    // command can rewrite it.
    let record: ClientConfig;
    try {
      record = clientConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    } catch {
      throw new Error(
        `the client record at ${path} does not load; \`aivi configure --url <url> --home <path> --app-dir <path>\` writes it fresh around whatever survives`,
      );
    }
    printRecord(record);
    return;
  }
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      base = rescue(parsed as Record<string, unknown>);
    // A file that is not JSON at all has nothing to carry; the edits start
    // the record fresh, and say so before the view prints.
    else process.stdout.write(`the record at ${path} was not JSON; writing it fresh\n`);
  } catch {
    process.stdout.write(`the record at ${path} did not parse; writing it fresh\n`);
  }
  if (edits.url !== undefined) base.url = checkedUrl(edits.url);
  if (edits.home !== undefined) base.home = checkedDir('home', edits.home);
  if (edits.appDir !== undefined) base.appDir = checkedDir('app dir', edits.appDir);
  base.configVersion = 1;
  const next = clientConfigSchema.parse(base);
  // The same write dance `saveClientConfig` keeps: 0600 on create, and a
  // chmod after, because a mode asked at write time does not touch a file
  // that already existed.
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  printRecord(next);
}
