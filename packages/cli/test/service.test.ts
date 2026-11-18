/** The service commands as a unit: what they ask of launchd, systemd and the
 *  disk on each platform. The platform, the home directory, the process spawn,
 *  the file system and stdout are mocks; every effect is recorded in order, so
 *  a test reads what would have happened to the machine. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  launchdPlist,
  serviceInstall,
  serviceInstalled,
  serviceLogs,
  serviceRestart,
  serviceStart,
  serviceStatus,
  serviceStop,
  serviceUninstall,
  serviceUnitPath,
  systemdUnit,
} from '../src/service.ts';

const HOME = '/users/test';
const PLIST = join(HOME, 'Library', 'LaunchAgents', 'ai.aivi.server.plist');
const UNIT = join(HOME, '.config', 'systemd', 'user', 'aivi.service');
const LABEL = 'gui/501/ai.aivi.server';
const options = { home: '/users/test/.aivi', appDir: '/users/test/.aivi/app', nodePath: '/usr/bin/node' };
const unsupported = new Error('aivi service is not supported on win32.');

interface Machine {
  platform: NodeJS.Platform;
  /** The paths that exist: the installed unit files. */
  present?: string[];
  /** The exit status of a command, by `command arg arg`; absent means 0. `null` is a signal. */
  exit?: Record<string, number | null>;
  /** The error `spawnSync` reports for every command. */
  spawnError?: Error;
  /** Nobody is reading stdout. */
  stdoutClosed?: boolean;
  /** The platform has no `getuid`. */
  noGetuid?: boolean;
}

/** A machine of the given platform. `effects` is what the unit did to it, in order. */
function machine(t: TestContext, spec: Machine) {
  const effects: string[][] = [];
  const spawnOptions: unknown[] = [];
  const present = new Set(spec.present ?? []);
  t.mock.property(process, 'platform', spec.platform);
  t.mock.method(os, 'homedir', () => HOME);
  if (spec.noGetuid) t.mock.property(process, 'getuid', undefined);
  else t.mock.method(process as unknown as { getuid(): number }, 'getuid', () => 501);
  t.mock.method(fs, 'existsSync', (path: string) => present.has(path));
  t.mock.method(fs, 'mkdirSync', (path: string, mkdirOptions: object) => {
    effects.push(['mkdir', path, JSON.stringify(mkdirOptions)]);
  });
  t.mock.method(fs, 'writeFileSync', (path: string, data: string) => {
    effects.push(['write', path, data]);
  });
  t.mock.method(fs, 'chmodSync', (path: string, mode: number) => {
    effects.push(['chmod', path, mode.toString(8)]);
  });
  t.mock.method(fs, 'rmSync', (path: string) => {
    effects.push(['rm', path]);
  });
  t.mock.method(fs, 'writeSync', (_fd: number, text: string) => {
    if (spec.stdoutClosed) throw new Error('EPIPE: broken pipe');
    effects.push(['stdout', text]);
    return text.length;
  });
  t.mock.method(childProcess, 'spawnSync', (command: string, args: string[], spawnWith: unknown) => {
    effects.push(['run', command, ...args]);
    spawnOptions.push(spawnWith);
    if (spec.spawnError) return { error: spec.spawnError, status: null };
    const key = [command, ...args].join(' ');
    return { status: spec.exit && key in spec.exit ? spec.exit[key] : 0 };
  });
  t.mock.method(console, 'log', (line: string) => {
    effects.push(['log', line]);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { effects, spawnOptions };
}

test('on macOS the unit file is the LaunchAgent plist, and the service is installed when it exists', t => {
  const m = machine(t, { platform: 'darwin', present: [PLIST] });

  assert.equal(serviceUnitPath(), PLIST);
  assert.equal(serviceInstalled(), true);
  assert.deepEqual(m.effects, []);
});

test('on Linux the unit file is under the user’s systemd directory, and the service is installed when it exists', t => {
  machine(t, { platform: 'linux' });
  assert.equal(serviceUnitPath(), UNIT);
  assert.equal(serviceInstalled(), false, 'no unit file yet');
});

test('on any other platform there is no unit file, and nothing is installed', t => {
  machine(t, { platform: 'win32', present: [PLIST, UNIT] });
  assert.equal(serviceUnitPath(), undefined);
  assert.equal(serviceInstalled(), false);
});

test('install on macOS writes the plist for the owner only, then reloads it: bootout first, bootstrap after', t => {
  const m = machine(t, { platform: 'darwin' });

  serviceInstall(options);

  assert.deepEqual(m.effects, [
    ['mkdir', join(options.home, 'state', 'logs'), '{"recursive":true}'],
    ['write', PLIST, launchdPlist(options)],
    ['chmod', PLIST, '600'],
    ['run', 'launchctl', 'bootout', LABEL],
    ['run', 'launchctl', 'bootstrap', 'gui/501', PLIST],
  ]);
  assert.deepEqual(m.spawnOptions, [{ stdio: 'inherit' }, { stdio: 'inherit' }], 'the person sees the output');
});

test('install on macOS tolerates a bootout that fails, and says how a failed bootstrap ended', t => {
  machine(t, {
    platform: 'darwin',
    exit: { [`launchctl bootout ${LABEL}`]: 3, [`launchctl bootstrap gui/501 ${PLIST}`]: 5 },
  });
  assert.throws(() => serviceInstall(options), new Error(`launchctl bootstrap gui/501 ${PLIST} failed (exit 5)`));
});

test('a command that a signal killed ends the install with “exit signal”', t => {
  machine(t, { platform: 'darwin', exit: { [`launchctl bootstrap gui/501 ${PLIST}`]: null } });
  assert.throws(() => serviceInstall(options), new Error(`launchctl bootstrap gui/501 ${PLIST} failed (exit signal)`));
});

test('a command that cannot be started is the error the system gave', t => {
  const missing = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
  machine(t, { platform: 'linux', spawnError: missing });
  assert.throws(() => serviceInstall(options), missing);
});

test('install on Linux writes the user unit, reloads systemd, enables and starts it, and says how to keep it past logout', t => {
  const m = machine(t, { platform: 'linux' });

  serviceInstall(options);

  assert.deepEqual(m.effects, [
    ['mkdir', join(options.home, 'state', 'logs'), '{"recursive":true}'],
    ['mkdir', join(HOME, '.config', 'systemd', 'user'), '{"recursive":true}'],
    ['write', UNIT, systemdUnit(options)],
    ['run', 'systemctl', '--user', 'daemon-reload'],
    ['run', 'systemctl', '--user', 'enable', '--now', 'aivi.service'],
    ['log', 'Headless machine? The service stops with your session unless it lingers: loginctl enable-linger'],
  ]);
});

test('install is refused where aivi installs no service, after the log directory is made', t => {
  const m = machine(t, { platform: 'win32' });

  assert.throws(
    () => serviceInstall(options),
    new Error('aivi service install is not supported on win32; run `aivi serve` in the foreground.'),
  );
  assert.deepEqual(m.effects, [['mkdir', join(options.home, 'state', 'logs'), '{"recursive":true}']]);
});

test('uninstall on macOS boots the job out, tolerating a job that is not loaded, and removes the plist', t => {
  const m = machine(t, { platform: 'darwin', present: [PLIST], exit: { [`launchctl bootout ${LABEL}`]: 3 } });

  serviceUninstall();

  assert.deepEqual(m.effects, [
    ['run', 'launchctl', 'bootout', LABEL],
    ['rm', PLIST],
  ]);
});

test('uninstall on Linux disables the unit, removes it, and reloads systemd', t => {
  const m = machine(t, { platform: 'linux', present: [UNIT] });

  serviceUninstall();

  assert.deepEqual(m.effects, [
    ['run', 'systemctl', '--user', 'disable', '--now', 'aivi.service'],
    ['rm', UNIT],
    ['run', 'systemctl', '--user', 'daemon-reload'],
  ]);
});

for (const platform of ['darwin', 'linux'] as const) {
  test(`uninstall on ${platform} with no unit file does nothing`, t => {
    const m = machine(t, { platform });

    serviceUninstall();

    assert.deepEqual(m.effects, []);
  });
}

test('uninstall is refused where aivi installs no service', t => {
  machine(t, { platform: 'win32' });
  assert.throws(() => serviceUninstall(), unsupported);
});

const commands = [
  [
    'start',
    serviceStart,
    ['launchctl', 'bootstrap', 'gui/501', PLIST],
    ['systemctl', '--user', 'start', 'aivi.service'],
  ],
  ['status', serviceStatus, ['launchctl', 'print', LABEL], ['systemctl', '--user', 'status', 'aivi.service']],
  [
    'logs',
    () => serviceLogs(options.home),
    ['tail', '-n', '100', '-f', join(options.home, 'state', 'logs', 'service.out.log')],
    ['journalctl', '--user', '-u', 'aivi.service', '-n', '100', '-f'],
  ],
] as const;

for (const [name, run, darwin, linux] of commands) {
  for (const [platform, command] of [
    ['darwin', darwin],
    ['linux', linux],
  ] as const) {
    test(`${name} on ${platform} runs ${command[0]}`, t => {
      const m = machine(t, { platform });

      run();

      assert.deepEqual(m.effects, [['run', ...command]]);
    });
  }
  test(`${name} is refused where aivi installs no service`, t => {
    machine(t, { platform: 'win32' });
    assert.throws(run, unsupported);
  });
}

test('status and a start on macOS show what the tool says, whatever its exit: a stopped job is not an error', t => {
  machine(t, {
    platform: 'darwin',
    exit: { [`launchctl print ${LABEL}`]: 113, [`launchctl bootstrap gui/501 ${PLIST}`]: 37 },
  });
  serviceStatus();
  serviceStart();
});

test('a start on Linux fails when systemctl fails, and says how it ended', t => {
  machine(t, { platform: 'linux', exit: { 'systemctl --user start aivi.service': 1 } });
  assert.throws(serviceStart, new Error('systemctl --user start aivi.service failed (exit 1)'));
});

test('a platform with no getuid addresses the root domain', t => {
  const m = machine(t, { platform: 'darwin', noGetuid: true });

  serviceStart();

  assert.deepEqual(m.effects, [['run', 'launchctl', 'bootstrap', 'gui/0', PLIST]]);
});

test('stop and restart say so when no service is installed, and touch nothing', t => {
  const m = machine(t, { platform: 'darwin' });

  assert.throws(serviceStop, new Error('not running as a service'));
  assert.throws(serviceRestart, new Error('not running as a service'));
  assert.deepEqual(m.effects, []);
});

test('stop on macOS says it first, in plain bytes, then boots the job out whatever its state', t => {
  const m = machine(t, { platform: 'darwin', present: [PLIST], exit: { [`launchctl bootout ${LABEL}`]: 3 } });

  serviceStop();

  assert.deepEqual(m.effects, [
    ['stdout', 'server stopping…\n'],
    ['run', 'launchctl', 'bootout', LABEL],
  ]);
});

test('stop on Linux says it first, then stops the unit', t => {
  const m = machine(t, { platform: 'linux', present: [UNIT] });

  serviceStop();

  assert.deepEqual(m.effects, [
    ['stdout', 'server stopping…\n'],
    ['run', 'systemctl', '--user', 'stop', 'aivi.service'],
  ]);
});

test('restart on macOS says it first, then kicks the running job', t => {
  const m = machine(t, { platform: 'darwin', present: [PLIST] });

  serviceRestart();

  assert.deepEqual(m.effects, [
    ['stdout', 'server restarting…\n'],
    ['run', 'launchctl', 'kickstart', '-k', LABEL],
  ]);
});

test('restart on macOS boots a job that was stopped fresh, when there is nothing to kick', t => {
  const m = machine(t, { platform: 'darwin', present: [PLIST], exit: { [`launchctl kickstart -k ${LABEL}`]: 113 } });

  serviceRestart();

  assert.deepEqual(m.effects, [
    ['stdout', 'server restarting…\n'],
    ['run', 'launchctl', 'kickstart', '-k', LABEL],
    ['run', 'launchctl', 'bootstrap', 'gui/501', PLIST],
  ]);
});

test('restart on Linux restarts the unit', t => {
  const m = machine(t, { platform: 'linux', present: [UNIT] });

  serviceRestart();

  assert.deepEqual(m.effects, [
    ['stdout', 'server restarting…\n'],
    ['run', 'systemctl', '--user', 'restart', 'aivi.service'],
  ]);
});

test('a closed stdout has nobody to tell, and does not stop the restart', t => {
  const m = machine(t, { platform: 'linux', present: [UNIT], stdoutClosed: true });

  serviceRestart();

  assert.deepEqual(m.effects, [['run', 'systemctl', '--user', 'restart', 'aivi.service']]);
});
