import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { clientConfigPath, saveClientConfig } from '../src/client-config.ts';
import { homeForCreate, homeFromEnvOrConfig, machineStatus, requireHome } from '../src/home.ts';

test('home selection uses the environment, then a valid client record, then the creation default', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aivi-home-'));
  const original = process.env;
  const config = join(directory, 'client.json');
  process.env = { ...original, AIVI_CONFIG: config };
  delete process.env.AIVI_HOME;
  delete process.env.AIVI_EXEC_SESSION;
  t.after(() => {
    process.env = original;
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(homeFromEnvOrConfig(), undefined);
  assert.equal(homeForCreate(), join(homedir(), '.aivi'));
  assert.deepEqual(machineStatus(), {});
  assert.throws(() => requireHome(), /No aivi home known/);

  saveClientConfig({ home: join(directory, 'home') });
  assert.equal(homeFromEnvOrConfig(), join(directory, 'home'));
  assert.equal(homeForCreate(), join(directory, 'home'));
  assert.equal(requireHome(), join(directory, 'home'));
  assert.deepEqual(machineStatus(), { home: join(directory, 'home'), clientConfig: config });

  process.env.AIVI_HOME = 'relative-home';
  process.env.AIVI_EXEC_SESSION = '1';
  assert.equal(homeForCreate(), resolve('relative-home'));
  assert.deepEqual(machineStatus(), { home: resolve('relative-home'), clientConfig: config, remote: true });

  delete process.env.AIVI_HOME;
  writeFileSync(config, '{broken');
  assert.equal(homeFromEnvOrConfig(), undefined);
  assert.equal(homeForCreate(), join(homedir(), '.aivi'));
  assert.deepEqual(machineStatus(), { clientConfig: config, remote: true });
});

test('the client config path resolves explicit files and falls back through XDG to the user directory', t => {
  const original = process.env;
  process.env = { ...original, AIVI_CONFIG: 'dev/client.json', XDG_CONFIG_HOME: '/custom/config' };
  t.after(() => {
    process.env = original;
  });
  assert.equal(clientConfigPath(), resolve('dev/client.json'));
  delete process.env.AIVI_CONFIG;
  assert.equal(clientConfigPath(), '/custom/config/aivi/config.json');
  delete process.env.XDG_CONFIG_HOME;
  assert.equal(clientConfigPath(), resolve(homedir(), '.config', 'aivi', 'config.json'));
});
