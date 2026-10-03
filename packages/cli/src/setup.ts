/** `aivi setup` — the one entry point for client and server. It signs this
 *  machine in to an existing host, or creates the server here and signs the
 *  operator in; either way the OpenCode plugins go in and the last line says
 *  a verified truth ("Signed in as …"), never a promise the CLI cannot keep.
 *  `server create` folded into the create branch: its identity step stays as
 *  the plumbing that mints person and token inside the freshly installed
 *  server. This file spawns npm and `opencode plugin add` and reaches the
 *  identity step through a dynamic import of the installed server (mount.ts);
 *  it imports no host code statically — the whoami check is one plain fetch. */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { loadClientConfig, saveClientConfig } from './client-config.ts';
import { importApp } from './mount.ts';
import { serviceInstall } from './service.ts';
import { aiviVersion } from './version.ts';

/** Both plugins a signed-in machine needs: the aivi tools and the commit
 *  attribution. `opencode plugin add` is idempotent, so setup may re-run it.
 *  `aivi uninstall` removes the aivi one and asks about the attribution one,
 *  which is not aivi's. */
export const AIVI_PLUGIN = '@aivi/opencode';
export const ATTRIBUTION_PLUGIN = 'opencode-attribution';
const CLIENT_PLUGINS = [AIVI_PLUGIN, ATTRIBUTION_PLUGIN];

/** The OpenCode shape of a server home: the service `aivi serve` runs loads
 *  these from the home. A file that exists is never overwritten. The three
 *  lane workers are the template's strong defaults (docs/plans/templates/
 *  scaffolding.md): written once, then plain files — editing them is the
 *  whole configuration, deleting them is the only uninstall. */
const HOME_AGENTS = ['assistant.md', 'dreamer.md', 'product.md', 'dev.md', 'review.md'];

const SCRIPT_FORM =
  'setup needs an interactive terminal; in a script use: aivi setup --use this-machine|another --name TEXT, or aivi setup --connect --url URL --token TOKEN';

/** A prompt the person cancelled; the flow stops with nothing further written. */
class Cancelled extends Error {}

/** How others reach the machine, from the create flow's one question. */
export type Reach = { kind: 'none' } | { kind: 'lan'; bind: string } | { kind: 'url'; url: string };

/** Usable LAN/tailnet addresses: non-internal IPv4, de-duplicated. */
function lanBinds(): { name: string; addr: string }[] {
  const seen = new Set<string>();
  const binds: { name: string; addr: string }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !seen.has(addr.address)) {
        seen.add(addr.address);
        binds.push({ name, addr: addr.address });
      }
    }
  }
  return binds;
}

export interface Identity {
  home: string;
  url: string;
  person: string;
  name?: string;
  token: string;
  next?: string;
  /** Caveat on the printed url (a loopback or LAN guess the operator should know about), if any. */
  urlNote?: string;
}

/** What the identity step is asked for: where the server will run, the
 *  operator's name, and the reach address when one was given. */
export interface IdentityStep {
  use: 'this-machine' | 'another';
  name: string;
  public?: string;
  lanBind?: string;
}

export interface WhoamiResult {
  person: { id: string; name: string };
  roles: string[];
}

export interface SetupIo {
  install(specs: string[], appDir: string): void;
  /** Rebuild `<state>/cache/schema.json` and config.json's `$schema` line, in
   *  the installed app's code; called after the plugin list is written. */
  rebuildSchema(home: string, appDir: string): Promise<void>;
  npmView(spec: string, field: string): Promise<string>;
  /** The identity step, called in-process in the installed app's code: the
   *  person and token are minted in its store, the answer is the object, no
   *  stdout carries it. */
  createIdentity(step: IdentityStep, home: string, appDir: string): Promise<Identity>;
  opencodeOnPath(): boolean;
  pluginAdd(pkg: string): void;
  health(url: string): Promise<boolean>;
  whoami(url: string, token: string): Promise<WhoamiResult>;
  serviceInstall(options: { home: string; appDir: string; nodePath: string }): void;
  ask: {
    branch(): Promise<'connect' | 'create'>;
    machine(): Promise<'this-machine' | 'another'>;
    background(): Promise<boolean>;
    name(): Promise<string>;
    reach(): Promise<Reach>;
    url(): Promise<string>;
    token(): Promise<string>;
  };
  log(message: string): void;
  warn(message: string): void;
}

export interface SetupOptions {
  home: string;
  nodePath?: string | undefined;
}

export interface SetupFlags {
  hostPackage: string | undefined;
  use: string | undefined;
  connect: boolean;
  url: string | undefined;
  token: string | undefined;
  name: string | undefined;
  public: string | undefined;
}

/** The valued flags, each with its setter. `--plugin` collects; the rest take
 *  one value, as `--flag value` or `--flag=value` — the same two shapes for all. */
const SETUP_FLAGS: Record<string, (flags: SetupFlags, value: string) => void> = {
  '--host-package': (flags, value) => {
    flags.hostPackage = value;
  },
  '--use': (flags, value) => {
    flags.use = value;
  },
  '--url': (flags, value) => {
    flags.url = value;
  },
  '--token': (flags, value) => {
    flags.token = value;
  },
  '--name': (flags, value) => {
    flags.name = value;
  },
  '--public': (flags, value) => {
    flags.public = value;
  },
};

export function extractSetupFlags(args: string[]): SetupFlags {
  const flags: SetupFlags = {
    hostPackage: undefined,
    use: undefined,
    connect: false,
    url: undefined,
    token: undefined,
    name: undefined,
    public: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--connect') {
      flags.connect = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const setter = SETUP_FLAGS[name];
    if (!setter) throw new Error(`Unknown setup flag: ${arg}`);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`${name} wants a value`);
    setter(flags, value);
  }
  return flags;
}

/** Which flow this invocation follows. An already signed-in machine gets the
 *  quiet refresh; a home with a server but no sign-in skips the url question. */
async function routeSetup(
  flags: SetupFlags,
  existing: ReturnType<typeof loadClientConfig>,
  home: string,
  nodePath: string,
  io: SetupIo,
): Promise<void> {
  if (flags.connect) return connectFlow(flags.url ?? existing?.url, flags.token, io);
  if (flags.use !== undefined) return createFlow(flags, home, nodePath, io);
  if (existing?.person?.token && existing.url) return signedInFlow(existing.url, existing.person.token, io);
  if (serverInstalled(home)) {
    // The server lives here but nobody has signed in on this machine:
    // the url is a fact of this home, only the token is missing.
    io.log(`The aivi server lives at ${home}; this machine has not signed in yet.`);
    return connectFlow(homeHostUrl(home), undefined, io);
  }
  const branch = await io.ask.branch();
  return branch === 'connect' ? connectFlow(flags.url, flags.token, io) : createFlow(flags, home, nodePath, io);
}

export async function setup(args: string[], options: SetupOptions, io: SetupIo = defaultIo): Promise<void> {
  const flags = extractSetupFlags(args);
  const home = options.home;
  const nodePath = options.nodePath ?? process.execPath;
  if (flags.use !== undefined && flags.connect)
    throw new Error('`--connect` and `--use` choose different branches; give one.');
  if (flags.use !== undefined && !['this-machine', 'another'].includes(flags.use))
    throw new Error(`Unknown --use ${flags.use}. Use this-machine or another.`);
  try {
    await routeSetup(flags, loadClientConfig(), home, nodePath, io);
  } catch (error) {
    if (error instanceof Cancelled) {
      p.cancel('Setup stopped. Nothing further was written.');
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

/** Already signed in: verify the truth, refresh the display cache, make sure
 *  the plugins are in. A failure says so and stops — it never deletes. */
async function signedInFlow(url: string, token: string, io: SetupIo): Promise<void> {
  const who = await verify(url, token, io);
  const person = loadClientConfig()?.person;
  saveClientConfig({ person: { ...person, token, id: who.person.id, name: who.person.name, roles: who.roles } });
  await ensurePlugins(io);
  io.log(`Signed in as ${who.person.name}. Open OpenCode — the aivi tools are there.`);
}

async function connectFlow(url: string | undefined, token: string | undefined, io: SetupIo): Promise<void> {
  io.log(
    'On the host: `aivi people create NAME` makes a person and offers to mint their token right away;' +
      ' `aivi people token PERSON` mints another bearer. The token is shown once.',
  );
  const host = url ?? (await io.ask.url());
  const bearer = token ?? (await io.ask.token());
  const who = await verify(host, bearer, io);
  saveClientConfig({
    url: host,
    person: { token: bearer, id: who.person.id, name: who.person.name, roles: who.roles },
  });
  await ensurePlugins(io);
  io.log(`Signed in as ${who.person.name}. Open OpenCode — the aivi tools are there.`);
}

/** The home structure; a populated home is preserved, only missing pieces are written. */
function writeHomeSkeleton(home: string): string {
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  const envPath = join(home, '.env');
  if (!existsSync(envPath))
    writeFileSync(envPath, '# aivi secrets; this file stays local. fnox exec works too.\n', { mode: 0o600 });
  const appDir = join(home, 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, '.npmrc'),
    '# npm lifecycle scripts aivi allow-lists; empty until one proves necessary.\n',
  );
  // The manifest npm installs against, written and not left to npm's guess of
  // the project root: a home that lives inside another package (a repository
  // checkout, a dotfiles home) must never anchor the install at that ancestor.
  if (!existsSync(join(appDir, 'package.json')))
    writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({ name: 'aivi-server', private: true }, null, 2)}\n`);
  return appDir;
}

/** The reach answer carried into the identity step. */
function reachStep(reach: Reach): Pick<IdentityStep, 'public' | 'lanBind'> {
  if (reach.kind === 'url') return { public: reach.url };
  if (reach.kind === 'lan') return { lanBind: reach.bind };
  return {};
}

/** Say what the identity step returned: caveats first, then the paste-able
 *  handoff for the other machine when that is where the person will sign in. */
function printIdentity(identity: Identity, use: string, home: string, io: SetupIo): void {
  if (identity.urlNote) io.warn(identity.urlNote);
  if (use !== 'another') return;
  io.log(`The server home is ready at ${home}. Take these to the other machine — the token is shown once:`);
  io.log(`  url:   ${identity.url}`);
  io.log(`  token: ${identity.token}`);
  io.log('There: `npm install -g @aivi/cli`, run `aivi setup`, choose "Connect to a host", and paste both.');
}

/** The reach answer: a flag wins; a scripted `--use` skips the question (unset is a valid answer). */
async function resolveReach(flags: SetupFlags, io: SetupIo): Promise<Reach> {
  if (flags.public) return { kind: 'url', url: flags.public };
  if (flags.use !== undefined) return { kind: 'none' };
  return io.ask.reach();
}

async function createFlow(flags: SetupFlags, home: string, nodePath: string, io: SetupIo): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 26) throw new Error(`aivi needs Node 26 (below 27); running ${process.versions.node}.`);
  const use = (flags.use ?? (await io.ask.machine())) as 'this-machine' | 'another';
  // A flag given skips its prompt, the identity step's own rule; a script
  // passing --use without --name gets the default operator name.
  const name = flags.name ?? (flags.use !== undefined ? 'Operator' : await io.ask.name());

  // The reach address: asked once here, stored by the identity step, used by
  // every printed URL.
  const reach = await resolveReach(flags, io);

  const appDir = writeHomeSkeleton(home);

  io.log(`Installing the aivi server into ${appDir}`);
  io.install([flags.hostPackage ?? '@aivi/host'], appDir);
  saveClientConfig({ home, appDir, nodePath, installMethod: 'npm' });

  // Setup installs the server alone: plugins join afterwards with `aivi add`,
  // which runs each plugin's own setup before it enters `aivi-plugins` — a
  // package listed without its block would make `aivi serve` complain. The
  // editor schema is rebuilt from the installed app's code, so the `$schema`
  // hint and the composed shape land together; a cache that cannot rebuild is
  // a warning, the truth of the home is config.json and the list.
  await rebuildSchemaOrSay(io, home, appDir);

  // The OpenCode shape of the home, before identity: the service finds its
  // agents and the plugin here whatever the sign-in path.
  await seedOpenCodeOrSay(io, home);

  // Identity is the installed app's own act: person and token are minted in
  // its store, and this-machine signs `~/.config/aivi.json` there.
  const identity = await io.createIdentity({ use, name, ...reachStep(reach) }, home, appDir);
  printIdentity(identity, use, home, io);
  if (use === 'another') return;

  await ensurePlugins(io);
  const background = process.stdin.isTTY ? await io.ask.background() : false;
  if (!background) {
    saveClientConfig({ person: { token: identity.token, ...(identity.name ? { name: identity.name } : {}) } });
    io.log(
      'Next: `aivi serve` starts the server in the foreground. Once it answers, `aivi setup` again verifies the sign-in.',
    );
    return;
  }
  await serveInBackground(io, home, appDir, nodePath, identity);
}

/** The editor schema rebuilt from the installed app; a cache that cannot
 *  rebuild is a warning — the truth of the home is config.json and the
 *  list, and `aivi add` or `aivi update` rebuilds it once the config loads. */
async function rebuildSchemaOrSay(io: SetupIo, home: string, appDir: string): Promise<void> {
  try {
    await io.rebuildSchema(home, appDir);
  } catch (error) {
    io.warn(
      `the editor schema was not rebuilt (${error instanceof Error ? error.message : String(error)}); \`aivi add\` or \`aivi update\` rebuilds it once config.json loads again.`,
    );
  }
}

/** Seed the home's OpenCode plugin at the version npm names today; no
 *  answer from npm seeds it unpinned and OpenCode installs the latest. */
async function seedOpenCodeOrSay(io: SetupIo, home: string): Promise<void> {
  const version = await io.npmView('@aivi/opencode', 'version').catch(() => undefined);
  if (!version)
    io.warn('Could not resolve @aivi/opencode on npm; seeded the plugin unpinned (OpenCode installs the latest).');
  seedHomeOpenCode(home, version ? `@aivi/opencode@${version}` : '@aivi/opencode');
}

/** The background ending: the service is installed, gets its thirty seconds
 *  to answer, and the client record signs in as the person the server says
 *  it is — the whoami is the proof, never the install's return. */
async function serveInBackground(
  io: SetupIo,
  home: string,
  appDir: string,
  nodePath: string,
  identity: Identity,
): Promise<void> {
  io.serviceInstall({ home, appDir, nodePath });
  if (!(await waitHealthy(identity.url, io)))
    throw new Error(`The server did not answer at ${identity.url} within 30 s. Check \`aivi service logs\`.`);
  const who = await io.whoami(identity.url, identity.token);
  saveClientConfig({ person: { token: identity.token, id: who.person.id, name: who.person.name, roles: who.roles } });
  io.log(`Signed in as ${who.person.name}. The server runs in the background; \`aivi service logs\` follows it.`);
}

/** One health probe plus one whoami: nothing is claimed before it is true. */
async function verify(url: string, token: string, io: SetupIo): Promise<WhoamiResult> {
  if (!(await io.health(url))) throw new Error(`No answer from ${url}. Is \`aivi serve\` running there?`);
  return io.whoami(url, token);
}

async function ensurePlugins(io: SetupIo): Promise<void> {
  if (!io.opencodeOnPath()) {
    const commands = CLIENT_PLUGINS.map(plugin => `opencode plugin add ${plugin}`).join(' && ');
    io.warn(`OpenCode is not on PATH, so the plugins were skipped. Install OpenCode, then run: ${commands}`);
    return;
  }
  for (const plugin of CLIENT_PLUGINS) io.pluginAdd(plugin);
}

/** Writes the home's OpenCode shape; whatever exists on disk is kept. */
export function seedHomeOpenCode(home: string, pluginSpec: string): void {
  const configPath = join(home, 'opencode.jsonc');
  if (!existsSync(configPath)) writeFileSync(configPath, opencodeJsonc(pluginSpec));
  const agentsDir = join(home, '.opencode', 'agents');
  for (const file of HOME_AGENTS) {
    const destination = join(agentsDir, file);
    if (existsSync(destination)) continue;
    mkdirSync(agentsDir, { recursive: true });
    copyFileSync(fileURLToPath(new URL(`../templates/agents/${file}`, import.meta.url)), destination);
  }
}

function opencodeJsonc(pluginSpec: string): string {
  return `{
  "$schema": "https://opencode.ai/config.json",
  // aivi's OpenCode home: the service \`aivi serve\` runs loads this file and
  // \`.opencode/agents/\`. Edit freely — \`aivi setup\` never overwrites what exists.
  "plugins": ["${pluginSpec}"]
  // Linear's hosted MCP through aivi's loopback forwarder: enable the \`linear\`
  // block in config.json (default port 4101) and add:
  // "mcp": { "linear": { "type": "remote", "url": "http://127.0.0.1:4101/mcp" } }
}
`;
}

function serverInstalled(home: string): boolean {
  return existsSync(join(home, 'app', 'node_modules', '@aivi', 'host'));
}

/** The host url of the server in this home, read as a plain file (the CLI
 *  never loads host code); the config defaults are the app's own. */
function homeHostUrl(home: string): string | undefined {
  let config: { host?: { bind?: string; port?: number } };
  try {
    config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as typeof config;
  } catch {
    return undefined;
  }
  const bind = config.host?.bind ?? '127.0.0.1';
  const host = ['0.0.0.0', '::', '[::]'].includes(bind) ? '127.0.0.1' : bind;
  const port = config.host?.port ?? 4100;
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

/** A bounded wait for a known instant: the service the setup just installed
 *  coming healthy, the same probe `aivi update` runs after its restart. */
async function waitHealthy(url: string, io: SetupIo): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (await io.health(url)) return true;
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/** One prompt with the two universal rules: a script without a TTY gets the
 *  script form, and a cancel stops the flow before the next thing is written.
 *  The target type is given by the caller: a clack prompt's return type mixes
 *  in its cancel symbol, and inference would drag that union out here. */
function guarded<T = string>(ask: () => Promise<unknown>): Promise<T> {
  if (!process.stdin.isTTY) return Promise.reject(new Cancelled(SCRIPT_FORM));
  return ask().then(answer => {
    if (p.isCancel(answer)) throw new Cancelled('an answer was cancelled');
    if (answer === undefined) throw new Cancelled('an answer came back empty');
    return answer as T;
  });
}

function spawnPrintable(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

const defaultIo: SetupIo = {
  install(specs, appDir) {
    const result = spawnSync('npm', ['install', '--save-exact', '--no-fund', ...specs], {
      cwd: appDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install failed (exit ${result.status ?? 'signal'})`);
  },
  async rebuildSchema(home, appDir) {
    const { writeEditorSchema } = await importApp<{ writeEditorSchema: (home: string) => Promise<string> }>(
      appDir,
      home,
      'dist/cli/schema-cache.js',
    );
    await writeEditorSchema(home);
  },
  async npmView(spec, field) {
    const result = spawnSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`npm view ${spec} ${field} failed`);
    return JSON.parse(result.stdout.trim()) as string;
  },
  async createIdentity(step, home, appDir) {
    // The identity step is the installed server's own code, called in-process:
    // it answers with the object, no child's stdout carries it. The host's
    // cli context reads the home importApp puts in the environment.
    const { serverCreate } = await importApp<{
      serverCreate: (options: {
        home: string;
        configPath: string;
        use?: string;
        name?: string;
        public?: string;
        lanBind?: string;
      }) => Promise<Identity>;
    }>(appDir, home, 'dist/cli/identity.js');
    return serverCreate({ home, configPath: join(home, 'config.json'), ...step });
  },
  opencodeOnPath: () => spawnPrintable('opencode', ['--version']),
  pluginAdd(pkg) {
    console.log(`Adding the ${pkg} plugin to OpenCode…`);
    const result = spawnSync('opencode', ['plugin', 'add', pkg], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`opencode plugin add ${pkg} failed (exit ${result.status ?? 'signal'}).`);
  },
  async health(url) {
    try {
      return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  },
  async whoami(url, token) {
    const response = await fetch(`${url}/whoami`, {
      headers: { 'x-aivi-client': aiviVersion, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401)
      throw new Error('That token does not name a person. Copy it again from `aivi people token` (it is shown once).');
    if (!response.ok) throw new Error(`whoami answered ${response.status}.`);
    return (await response.json()) as WhoamiResult;
  },
  serviceInstall,
  ask: {
    branch: () =>
      guarded<'connect' | 'create'>(() =>
        p.select({
          message: 'What should this machine be?',
          options: [
            { value: 'connect', label: 'Connect to an existing aivi host' },
            { value: 'create', label: 'Create a new aivi server here' },
          ],
        }),
      ),
    machine: () =>
      guarded<'this-machine' | 'another'>(() =>
        p.select({
          message: 'Will you use aivi on this machine, or is this a headless server?',
          options: [
            { value: 'this-machine', label: 'This machine — sign me in here too' },
            { value: 'another', label: 'Another machine — I will take the token there' },
          ],
        }),
      ),
    background: () =>
      guarded<boolean>(() =>
        p.confirm({
          message: 'Run aivi in the background (it starts at login and survives logouts)?',
          initialValue: true,
        }),
      ),
    name: () =>
      guarded(() => p.text({ message: 'Your name — aivi associates records with it', placeholder: 'Operator' })).then(
        value => value.trim() || 'Operator',
      ),
    reach: () =>
      guarded<'none' | 'lan' | 'url'>(() =>
        p.select({
          message: 'How will others reach this machine?',
          options: [
            { value: 'none', label: 'Only this machine (nothing outside can reach it)' },
            { value: 'lan', label: 'My network — anyone on the LAN or tailnet reaches aivi directly' },
            {
              value: 'url',
              label: 'A URL in front of it — a tunnel or proxy reaches loopback (Tailscale Funnel, cloudflared…)',
            },
          ],
        }),
      ).then(async kind => {
        if (kind === 'url') {
          const url = await guarded<string>(() =>
            p.text({
              message: 'The URL others reach this machine at',
              placeholder: 'https://you.tailscale.ts.net',
              validate: value => {
                const v = String(value ?? '').trim();
                if (!v) return 'A URL, or cancel back to "only this machine".';
                if (!/^https?:\/\/\S+$/.test(v)) return 'An http(s) URL, like https://you.tailscale.ts.net';
                if (v.endsWith('/')) return 'Drop the trailing slash.';
                return undefined;
              },
            }),
          );
          return { kind: 'url', url: url.trim() } as const;
        }
        if (kind === 'lan') {
          const binds = lanBinds();
          if (binds.length === 0) throw new Cancelled('no LAN or tailnet address was found on this machine');
          const bind = await guarded<string>(() =>
            p.select({
              message: 'Which address should aivi listen on?',
              options: binds.map(b => ({ value: b.addr, label: `${b.name} — ${b.addr}` })),
            }),
          );
          return { kind: 'lan', bind } as const;
        }
        return { kind: 'none' } as const;
      }),
    url: () =>
      guarded(() =>
        p.text({
          message: 'Host URL — where aivi answers',
          placeholder: 'http://127.0.0.1:4100',
          validate: value =>
            /^https?:\/\/\S+$/.test(String(value ?? '').trim())
              ? undefined
              : 'An http(s) URL, like http://127.0.0.1:4100',
        }),
      ).then(value => value.trim()),
    token: () =>
      guarded(() =>
        p.text({
          message: 'Person token — shown once at mint',
          validate: value => (String(value ?? '').trim() ? undefined : 'Paste the token shown by `aivi people token`'),
        }),
      ).then(value => value.trim()),
  },
  log: message => console.log(message),
  warn: message => console.warn(message),
};
