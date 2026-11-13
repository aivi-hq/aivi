import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { clientConfigPath } from '../src/client-config.ts';

test('the client config path prefers AIVI_CONFIG, then XDG, then the user config directory', () => {
  assert.equal(
    clientConfigPath({ AIVI_CONFIG: 'dev/client.json', XDG_CONFIG_HOME: '/ignored' }),
    resolve('dev/client.json'),
  );
  assert.equal(clientConfigPath({ XDG_CONFIG_HOME: '/custom/config' }), '/custom/config/aivi/config.json');
  assert.equal(clientConfigPath({}), resolve(homedir(), '.config', 'aivi', 'config.json'));
  assert.equal(
    clientConfigPath({ AIVI_CONFIG: '', XDG_CONFIG_HOME: '/custom/config' }),
    '/custom/config/aivi/config.json',
  );
});

test('the default environment is read at each call, not captured at import', t => {
  t.mock.property(process, 'env', { ...process.env, AIVI_CONFIG: 'first.json' });
  assert.equal(clientConfigPath(), resolve('first.json'));
  process.env.AIVI_CONFIG = 'second.json';
  assert.equal(clientConfigPath(), resolve('second.json'));
});
