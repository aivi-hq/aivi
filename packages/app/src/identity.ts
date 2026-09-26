/** The identity helpers: the one command that mints a person and token
 *  directly, and the client config file it signs in with. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig, printedBaseUrl, writeConfigBlock } from '@aivi/core';
import { Store } from '@aivi/host';
import * as p from '@clack/prompts';
import { hostUrl } from './context.ts';

/**
 * The identity step behind `aivi setup` — the only command that mints
 * identity directly: initialize the home, create the operator person and its
 * token (the secret is printed once; only its hash is kept), then decide
 * where the client setup happens. The question is asked before anything is
 * minted, so a cancel leaves nothing behind. A flag given skips its prompt;
 * `aivi setup` always gives the flags and says the human-facing words itself.
 */
export async function serverCreate(options: {
  home: string;
  configPath: string;
  use?: string | undefined;
  name?: string | undefined;
  public?: string | undefined;
  lanBind?: string | undefined;
}): Promise<Record<string, unknown>> {
  const { home, configPath } = options;
  const use = options.use;
  if (use !== undefined && use !== 'this-machine' && use !== 'another')
    throw new Error(`Unknown --use ${use}. Use this-machine or another.`);
  if (use === undefined && !process.stdin.isTTY)
    throw new Error(
      'setup needs an interactive terminal; in a script use: aivi setup --use this-machine|another [--name TEXT]',
    );
  if (use === undefined) p.intro('aivi setup — identity');
  const where = await askWhere(use);
  if (where === undefined) return {};
  const name = await askName(options.name, use);
  if (name === undefined) return {};

  mkdirSync(home, { recursive: true });
  if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  // The reach address lands before anything reads the config: an invalid
  // value fails here, with nothing minted yet.
  const reachable = await storeReach(configPath, options);
  const loaded = await loadConfig(configPath);
  const store = new Store(resolve(loaded.config.stateDirectory, 'aivi.sqlite'));
  try {
    if (store.people().length > 0)
      throw new Error('This home already has people. Use `aivi people create` for the next person.');
    const person = store.createPerson({ name, roles: ['operator'] });
    const { secret } = store.mintToken(person.id, 'operator');
    const printed = printedBaseUrl(loaded.config);
    const clientConfig = where === 'this-machine' ? writeClientConfig(hostUrl(loaded), home, secret) : undefined;
    if (use === undefined)
      p.outro(
        where === 'this-machine'
          ? `Home ready at ${home}; client config written.`
          : `Home ready at ${home}; take the token to your laptop.`,
      );
    return identityResult({
      home,
      configPath,
      where,
      person: person.id,
      personName: person.name,
      secret,
      clientConfig,
      url: printed.url,
      declared: printed.declared,
      bind: loaded.config.host.bind,
      reachable,
      publicBase: options.public,
    });
  } finally {
    store.close();
  }
}

/** The identity step's answer: what is true now, plus the caveats whoever
 *  carries these values needs. Assembled here to keep the minting legible. */
function identityResult(a: {
  home: string;
  configPath: string;
  where: string;
  person: string;
  personName: string;
  secret: string;
  clientConfig: string | undefined;
  url: string;
  declared: boolean;
  bind: string;
  reachable: boolean | undefined;
  publicBase: string | undefined;
}): Record<string, unknown> {
  const note = a.where === 'another' && !a.declared ? urlNote(a.url, a.bind, a.configPath) : undefined;
  return {
    home: a.home,
    url: a.url,
    person: a.person,
    name: a.personName,
    token: a.secret,
    ...(a.clientConfig ? { clientConfig: a.clientConfig } : {}),
    ...(note ? { urlNote: note } : {}),
    ...(a.reachable === undefined ? {} : { probeNote: probeNote(a.reachable, a.publicBase!) }),
    next:
      a.where === 'this-machine'
        ? 'Identity ready. `aivi setup` installs the OpenCode plugins and verifies the sign-in.'
        : 'Install aivi on the other machine (`npm install -g @aivi/cli`), run `aivi setup` there, choose "Connect to a host", and paste this url and token.',
  };
}

/** Store the reach address, then soft-probe a declared base — inform, never
 *  block: a tunnel that is correct but not running yet must stay storable. */
async function storeReach(
  configPath: string,
  options: { public?: string | undefined; lanBind?: string | undefined },
): Promise<boolean | undefined> {
  if (options.lanBind) await writeConfigBlock(configPath, ['host', 'bind'], options.lanBind);
  if (options.public) await writeConfigBlock(configPath, ['host', 'public'], options.public);
  return options.public ? await probePublic(options.public) : undefined;
}

/** A caveat on the printed url when it is a guess the receiver should know about. */
function urlNote(url: string, bind: string, configPath: string): string {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(bind)
    ? `${url} answers on this machine only. Once a funnel or tunnel exists, store its URL as host.public in ${configPath} — webhook platforms need it.`
    : `${url} answers inside your network only. Once a funnel or tunnel exists, store its URL as host.public in ${configPath}.`;
}

function probeNote(reachable: boolean, base: string): string {
  return reachable
    ? `Reachability: ${base} answers.`
    : `Reachability: ${base}/health did not answer yet — fine if the tunnel is not up; installs that need deliveries test it hard before trusting it.`;
}

/** The cancel screen; returns undefined so a step can hand "the speaker stopped" back. */
function stopped(why: string): undefined {
  p.cancel(`Setup stopped: ${why}. Nothing was created.`);
  process.exitCode = 1;
}

/** Where the person will use aivi; undefined when they stopped. */
async function askWhere(use: string | undefined): Promise<string | undefined> {
  const where =
    use ??
    (await p.select({
      message: 'Where will you use aivi?',
      options: [
        { value: 'this-machine', label: 'This machine — set up the client here too' },
        { value: 'another', label: 'Another machine — print the token and take it there' },
      ],
    }));
  if (p.isCancel(where)) return stopped('no answer');
  return where;
}

/** The display name, 'Operator' when nobody answered; undefined when the speaker stopped. */
async function askName(name: string | undefined, use: string | undefined): Promise<string | undefined> {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const answered =
    use === undefined
      ? await p.text({ message: 'Your name — aivi associates records with it', placeholder: 'Operator' })
      : undefined;
  if (answered !== undefined && p.isCancel(answered)) return stopped('no name');
  return (answered as string | undefined)?.trim() || 'Operator';
}

/** The bearer for commands that act as the operator over HTTP; absent when this
 *  machine has not signed in. */
export function readClientConfigToken(): string | undefined {
  const path = clientConfigPath();
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, 'utf8')) as { person?: { token?: string } };
  return config.person?.token;
}

/** The one client config file: `~/.config/aivi.json`, `$XDG_CONFIG_HOME/aivi.json`,
 *  or the file `AIVI_CONFIG` names — the same resolution the thin CLI uses. */
function clientConfigPath(): string {
  if (process.env.AIVI_CONFIG) return resolve(process.env.AIVI_CONFIG);
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'aivi.json');
}

/** The one client config file, identical shape everywhere; 0600. An existing person token is never overwritten. */
function writeClientConfig(url: string, home: string, token: string): string {
  const path = clientConfigPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if ((current.person as { token?: string } | undefined)?.token)
      throw new Error(`${path} already signs a person in; delete or edit it before signing in here`);
  }
  const next = { ...current, configVersion: 1, url, home, person: { token } };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Bounded, informative, never blocking: a few tries against `<base>/health`,
 * which is open and exempt from the version gate. A tunnel that is correct
 * but not running yet must stay storable, so a miss is a note, not an error.
 */
async function probePublic(base: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })).ok) return true;
    } catch {
      // retry; the last miss is what the caller reports
    }
    if (attempt < 2) await new Promise(done => setTimeout(done, 2000));
  }
  return false;
}
