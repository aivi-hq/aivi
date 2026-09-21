/** `aivi server create` — the one bootstrap. The CLI never runs host code: it
 *  writes the home structure, checks Node, installs the server package (plus
 *  any chosen channel plugins) into `<home>/app` with npm, records the
 *  installation in `~/.config/aivi.json`, and only then hands identity setup —
 *  the operator person and its token — to the freshly installed app's own
 *  `server create`. Install first, initialize second. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveClientConfig } from './client-config.ts';

export interface CreateIo {
  install(specs: string[], appDir: string): void;
  forwardIdentity(args: string[], home: string, appDir: string, nodePath: string): void;
  log(message: string): void;
}

export const defaultIo: CreateIo = {
  install(specs, appDir) {
    const result = spawnSync('npm', ['install', '--save-exact', '--no-fund', ...specs], {
      cwd: appDir,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm install failed (exit ${result.status ?? 'signal'})`);
  },
  forwardIdentity(args, home, appDir, nodePath) {
    const result = spawnSync(
      nodePath,
      [join(appDir, 'node_modules', '@aivi', 'app', 'dist', 'cli.js'), 'server', 'create', ...args],
      {
        stdio: 'inherit',
        env: { ...process.env, AIVI_HOME: home },
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  },
  log: message => console.log(message),
};

/** Pull the CLI's own flags out of `server create`'s arguments; everything else
 *  is forwarded to the app's identity step verbatim. */
export function extractCreateFlags(args: string[]): {
  plugins: string[];
  appSpec: string | undefined;
  forwarded: string[];
} {
  const plugins: string[] = [];
  let appSpec: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (flag: string): string => {
      if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
      const next = args[++i];
      if (next === undefined) throw new Error(`${flag} wants a value`);
      return next;
    };
    if (arg === '--plugin' || arg.startsWith('--plugin=')) {
      plugins.push(value('--plugin'));
      continue;
    }
    if (arg === '--app-spec' || arg.startsWith('--app-spec=')) {
      appSpec = value('--app-spec');
      continue;
    }
    forwarded.push(arg);
  }
  return { plugins, appSpec, forwarded };
}

export function serverCreate(
  args: string[],
  options: { home: string; nodePath?: string | undefined },
  io: CreateIo = defaultIo,
): void {
  const { plugins, appSpec, forwarded } = extractCreateFlags(args);
  const home = options.home;

  // 1. The home structure. A populated home is preserved: only missing pieces are written.
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');
  if (!existsSync(configPath)) writeFileSync(configPath, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  const envPath = join(home, '.env');
  if (!existsSync(envPath))
    writeFileSync(envPath, '# aivi secrets; this file stays local. fnox exec works too.\n', {
      mode: 0o600,
    });

  // 2. Node. The server's engines are >=26 <27; the managed runtime under
  //    <home>/runtime arrives with the service work, so an unsuitable Node says so now.
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 26) throw new Error(`aivi needs Node 26 (below 27); running ${process.versions.node}.`);
  const nodePath = options.nodePath ?? process.execPath;

  // 3. The package environment: one package.json, one lockfile, the server and
  //    the chosen plugins. Versions pin exact at install; `aivi update` rewrites them.
  const appDir = join(home, 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, '.npmrc'),
    '# npm lifecycle scripts aivi allow-lists; empty until one proves necessary.\n',
  );
  io.log(`Installing the aivi server into ${appDir}`);
  io.install([appSpec ?? '@aivi/app', ...plugins], appDir);

  // 4. The installation record. The app's own `server create` merges the client
  //    fields into this same file and never overwrites a signed-in person.
  saveClientConfig({ home, appDir, nodePath, installMethod: 'npm' });

  // 5. Identity, in the installed app: home, operator person, token, client sign-in.
  io.forwardIdentity(forwarded, home, appDir, nodePath);
  io.log(`Next: \`aivi serve\` starts the server in the foreground.`);
}
