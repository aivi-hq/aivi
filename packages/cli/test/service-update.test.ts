import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { parse as parsePlist } from 'plist';
import { tarballName } from '../src/runtime.ts';
import { launchdPlist, systemdUnit } from '../src/service.ts';
import { type UpdateIo, updateServer } from '../src/update.ts';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aivi-service-test-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('the LaunchAgent plist carries the launchd lessons: Interactive, WorkingDirectory, logs in the home', () => {
  const options = { home: '/Users/me/.aivi', appDir: '/Users/me/.aivi/app', nodePath: '/usr/local/bin/node' };
  const parsed = parsePlist(launchdPlist(options)) as Record<string, unknown>;
  assert.equal(parsed.Label, 'ai.aivi.server');
  assert.deepEqual(parsed.ProgramArguments, [
    '/usr/local/bin/node',
    '/Users/me/.aivi/app/node_modules/@aivi/app/dist/cli.js',
    'serve',
  ]);
  assert.equal(parsed.ProcessType, 'Interactive');
  assert.equal(parsed.KeepAlive, true);
  assert.equal(parsed.RunAtLoad, true);
  assert.equal(parsed.WorkingDirectory, options.appDir);
  assert.deepEqual(parsed.EnvironmentVariables, { AIVI_HOME: options.home });
  assert.equal(parsed.StandardOutPath, '/Users/me/.aivi/state/logs/service.out.log');
});

test('the systemd unit runs the same command and restarts on failure', () => {
  const unit = systemdUnit({ home: '/home/me/.aivi', appDir: '/home/me/.aivi/app', nodePath: '/usr/bin/node' });
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node \/home\/me\/.aivi\/app\/node_modules\/@aivi\/app\/dist\/cli\.js serve/,
  );
  assert.match(unit, /Environment=AIVI_HOME=\/home\/me\/.aivi/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('the managed Node tarball name maps platform and arch', () => {
  assert.equal(tarballName('darwin', 'arm64', '26.2.0'), 'node-v26.2.0-darwin-arm64.tar.gz');
  assert.equal(tarballName('linux', 'x64', '26.0.1'), 'node-v26.0.1-linux-x64.tar.gz');
  assert.throws(() => tarballName('win32', 'x64', '26.2.0'), /No managed Node/);
});

function fakeIo(over: Partial<UpdateIo>): UpdateIo {
  return {
    npmView: async (_spec, field) => (field === 'engines.node' ? '>=26 <27' : '0.2.0'),
    install: () => ({ status: 0, stderr: '' }),
    log: () => {},
    healthProbe: async () => true,
    service: { installed: () => false, stop: () => {}, start: () => {} },
    ...over,
  };
}

test('update is a no-op when the installed version is the target', async () => {
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'app'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ dependencies: { '@aivi/app': '0.1.0' } }));
  writeFileSync(
    join(appDir, 'node_modules', '@aivi', 'app', 'package.json'),
    JSON.stringify({ version: '0.2.0', engines: { node: '>=26 <27' } }),
  );
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1 }));
  const calls: string[] = [];
  await updateServer(
    { home, appDir, nodePath: process.execPath },
    fakeIo({
      npmView: async () => '0.2.0',
      install: () => {
        calls.push('install');
        return { status: 0, stderr: '' };
      },
    }),
  );
  assert.deepEqual(calls, []);
});

test('update installs the new server plus plugins at latest, stops and starts the service, and probes health', async () => {
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'app'), { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ dependencies: { '@aivi/app': '0.1.0', '@aivi/channel-discord': '0.1.0' } }),
  );
  writeFileSync(join(appDir, 'node_modules', '@aivi', 'app', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, host: { port: 4100 } }));
  const installs: string[][] = [];
  const service: string[] = [];
  await updateServer(
    { home, appDir, nodePath: process.execPath },
    fakeIo({
      install: specs => {
        installs.push(specs);
        return { status: 0, stderr: '' };
      },
      service: { installed: () => true, stop: () => service.push('stop'), start: () => service.push('start') },
    }),
  );
  assert.deepEqual(installs, [['@aivi/app@0.2.0', '@aivi/channel-discord@latest']]);
  assert.deepEqual(service, ['stop', 'start']);
});

test('a plugin whose peer range excludes the new host is pinned and excluded from the retry', async () => {
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'app'), { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ dependencies: { '@aivi/app': '0.1.0', '@aivi/channel-discord': '0.1.0' } }),
  );
  writeFileSync(join(appDir, 'node_modules', '@aivi', 'app', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1 }));
  const logs: string[] = [];
  const installs: string[][] = [];
  await updateServer(
    { home, appDir, nodePath: process.execPath },
    fakeIo({
      healthProbe: async () => false,
      install: specs => {
        installs.push(specs);
        return installs.length === 1
          ? {
              status: 1,
              stderr:
                'npm error While resolving: @aivi/channel-discord@0.2.0\nnpm error Could not resolve dependency: peer @aivi/host@"^0.2.0"',
            }
          : { status: 0, stderr: '' };
      },
      log: message => logs.push(message),
    }),
  );
  assert.deepEqual(installs, [['@aivi/app@0.2.0', '@aivi/channel-discord@latest'], ['@aivi/app@0.2.0']]);
  assert.ok(logs.some(line => line.includes('disabled: no compatible release (kept 0.1.0)')));
});

test('update refuses to touch a server that is running in the foreground', async () => {
  const home = join(directory, 'home');
  const appDir = join(home, 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'app'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ dependencies: { '@aivi/app': '0.1.0' } }));
  writeFileSync(join(appDir, 'node_modules', '@aivi', 'app', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1 }));
  await assert.rejects(
    updateServer(
      { home, appDir, nodePath: process.execPath },
      fakeIo({
        healthProbe: async () => true,
        service: { installed: () => false, stop: () => {}, start: () => {} },
      }),
    ),
    /running in the foreground/,
  );
});
