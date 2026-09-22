/** Background operation: a per-user LaunchAgent on macOS, a systemd user unit
 *  on Linux. The unit runs the same Node-plus-server command the foreground
 *  `aivi serve` runs, so an update is a stop, an install and a start no matter
 *  who started the server. Hand-rolled on purpose — OpenClaw and Hermes do the
 *  same and there is no maintained library for it; the plist XML comes from the
 *  `plist` package so paths are escaped properly.
 *
 *  LaunchAgent lessons learned from OpenClaw's launchd issues, baked in here:
 *  ProcessType=Interactive (without it launchd cold-start stalls for minutes),
 *  an explicit WorkingDirectory, and owner-only 0600 on the plist. */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { build as buildPlistXml } from 'plist';

export const SERVICE_LABEL = 'ai.aivi.server';

/** getuid is typed as possibly absent (Windows builds of Node); aivi only ever installs on darwin/linux. */
const uid = (): number => process.getuid?.() ?? 0;

export interface ServiceOptions {
  home: string;
  appDir: string;
  nodePath: string;
}

function appCli(appDir: string): string {
  return join(appDir, 'node_modules', '@aivi', 'app', 'dist', 'cli.js');
}

export function launchdPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'aivi.service');
}

/** The unit file this platform would use, undefined where aivi installs no
 *  service. `aivi uninstall` names the path before it deletes anything. */
export function serviceUnitPath(): string | undefined {
  return process.platform === 'darwin'
    ? launchdPlistPath()
    : process.platform === 'linux'
      ? systemdUnitPath()
      : undefined;
}

export function launchdPlist(options: ServiceOptions): string {
  return buildPlistXml({
    Label: SERVICE_LABEL,
    ProgramArguments: [options.nodePath, appCli(options.appDir), 'serve'],
    KeepAlive: true,
    RunAtLoad: true,
    ProcessType: 'Interactive',
    WorkingDirectory: options.appDir,
    EnvironmentVariables: { AIVI_HOME: options.home },
    StandardOutPath: join(options.home, 'state', 'logs', 'service.out.log'),
    StandardErrorPath: join(options.home, 'state', 'logs', 'service.err.log'),
  });
}

export function systemdUnit(options: ServiceOptions): string {
  return [
    '[Unit]',
    'Description=aivi server',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${options.nodePath} ${appCli(options.appDir)} serve`,
    `Environment=AIVI_HOME=${options.home}`,
    `WorkingDirectory=${options.appDir}`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function runOrThrow(command: string, args: string[], tolerateNonZero = false): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !tolerateNonZero)
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 'signal'})`);
}

export function serviceInstalled(): boolean {
  return process.platform === 'darwin'
    ? existsSync(launchdPlistPath())
    : process.platform === 'linux'
      ? existsSync(systemdUnitPath())
      : false;
}

export function serviceInstall(options: ServiceOptions): void {
  mkdirSync(join(options.home, 'state', 'logs'), { recursive: true });
  if (process.platform === 'darwin') {
    const path = launchdPlistPath();
    writeFileSync(path, launchdPlist(options));
    chmodSync(path, 0o600);
    const domain = `gui/${uid()}`;
    // Reinstalling over a loaded job: bootout first, or bootstrap fails with EEXIST.
    runOrThrow('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], true);
    runOrThrow('launchctl', ['bootstrap', domain, path]);
    return;
  }
  if (process.platform === 'linux') {
    const path = systemdUnitPath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, systemdUnit(options));
    runOrThrow('systemctl', ['--user', 'daemon-reload']);
    runOrThrow('systemctl', ['--user', 'enable', '--now', 'aivi.service']);
    console.log('Headless machine? The service stops with your session unless it lingers: loginctl enable-linger');
    return;
  }
  throw new Error(
    `aivi service install is not supported on ${process.platform}; run \`aivi serve\` in the foreground.`,
  );
}

export function serviceUninstall(): void {
  if (process.platform === 'darwin') {
    const path = launchdPlistPath();
    if (existsSync(path)) {
      runOrThrow('launchctl', ['bootout', `gui/${uid()}/${SERVICE_LABEL}`], true);
      rmSync(path);
    }
    return;
  }
  if (process.platform === 'linux') {
    const path = systemdUnitPath();
    if (existsSync(path)) {
      runOrThrow('systemctl', ['--user', 'disable', '--now', 'aivi.service'], true);
      rmSync(path);
      runOrThrow('systemctl', ['--user', 'daemon-reload']);
    }
    return;
  }
  throw new Error(`aivi service is not supported on ${process.platform}.`);
}

export function serviceStart(): void {
  if (process.platform === 'darwin') runOrThrow('launchctl', ['bootstrap', `gui/${uid()}`, launchdPlistPath()], true);
  else if (process.platform === 'linux') runOrThrow('systemctl', ['--user', 'start', 'aivi.service']);
  else throw new Error(`aivi service is not supported on ${process.platform}.`);
}

export function serviceStop(): void {
  if (process.platform === 'darwin') runOrThrow('launchctl', ['bootout', `gui/${uid()}/${SERVICE_LABEL}`], true);
  else if (process.platform === 'linux') runOrThrow('systemctl', ['--user', 'stop', 'aivi.service']);
  else throw new Error(`aivi service is not supported on ${process.platform}.`);
}

export function serviceRestart(): void {
  if (process.platform === 'darwin') runOrThrow('launchctl', ['kickstart', '-k', `gui/${uid()}/${SERVICE_LABEL}`]);
  else if (process.platform === 'linux') runOrThrow('systemctl', ['--user', 'restart', 'aivi.service']);
  else throw new Error(`aivi service is not supported on ${process.platform}.`);
}

export function serviceStatus(): void {
  if (process.platform === 'darwin') runOrThrow('launchctl', ['print', `gui/${uid()}/${SERVICE_LABEL}`], true);
  else if (process.platform === 'linux') runOrThrow('systemctl', ['--user', 'status', 'aivi.service'], true);
  else throw new Error(`aivi service is not supported on ${process.platform}.`);
}

export function serviceLogs(home: string): void {
  if (process.platform === 'darwin') {
    runOrThrow('tail', ['-n', '100', '-f', join(home, 'state', 'logs', 'service.out.log')]);
  } else if (process.platform === 'linux') {
    runOrThrow('journalctl', ['--user', '-u', 'aivi.service', '-n', '100', '-f']);
  } else throw new Error(`aivi service is not supported on ${process.platform}.`);
}
