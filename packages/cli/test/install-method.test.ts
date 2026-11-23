/** How this CLI was installed, and how it updates and goes away: npm, the table's
 *  one row, as commands. `spawnSync` is the mock that answers for npm. `aivi
 *  upgrade` is tested here too: it is two calls into the table, which stay real
 *  over that mock. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { detectInstallMethod, runInstallMethod } from '../src/install-method.ts';
import { upgradeCli } from '../src/upgrade.ts';

interface Answer {
  status: number | null;
  stdout?: string;
  error?: Error;
}

/** npm answers each command in turn; the mock records what it was asked. */
function npm(t: TestContext, answers: Answer[]) {
  const spawn = t.mock.method(childProcess, 'spawnSync', (_command: string, _args: string[], _options: unknown) =>
    answers.shift(),
  );
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return () => spawn.mock.calls.map(call => call.arguments);
}

const probe = ['npm', ['list', '-g', '@aivi/cli', '--depth=0'], { encoding: 'utf8' }];
const update = ['npm', ['install', '-g', '@aivi/cli@latest'], { stdio: 'inherit' }];

test('npm lists the CLI: it was installed with npm', t => {
  const asked = npm(t, [{ status: 0, stdout: '/usr/lib\n└── @aivi/cli@1.2.3\n' }]);

  assert.equal(detectInstallMethod(), 'npm');
  assert.deepEqual(asked(), [probe]);
});

for (const [why, answer] of [
  ['it does not list the CLI', { status: 0, stdout: '/usr/lib\n└── (empty)\n' }],
  ['the list fails', { status: 1, stdout: '@aivi/cli@1.2.3' }],
  ['the list prints nothing', { status: 0 }],
] as const) {
  test(`the CLI was installed some other way when ${why}`, t => {
    npm(t, [answer]);
    assert.equal(detectInstallMethod(), undefined);
  });
}

test('update and uninstall run npm in the person’s terminal', t => {
  const asked = npm(t, [{ status: 0 }, { status: 0 }]);

  runInstallMethod('npm', 'update');
  runInstallMethod('npm', 'uninstall');

  assert.deepEqual(asked(), [update, ['npm', ['uninstall', '-g', '@aivi/cli'], { stdio: 'inherit' }]]);
});

test('a command that cannot start is the error the system gave', t => {
  const missing = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
  npm(t, [{ status: null, error: missing }]);
  assert.throws(() => runInstallMethod('npm', 'update'), missing);
});

test('a command that fails is named, with how it ended', t => {
  npm(t, [{ status: 1 }, { status: null }]);

  assert.throws(() => runInstallMethod('npm', 'update'), new Error('npm install -g @aivi/cli@latest failed (exit 1)'));
  assert.throws(
    () => runInstallMethod('npm', 'uninstall'),
    new Error('npm uninstall -g @aivi/cli failed (exit signal)'),
  );
});

test('upgrade finds how the CLI was installed and updates it that way', t => {
  const asked = npm(t, [{ status: 0, stdout: '@aivi/cli@1.2.3' }, { status: 0 }]);

  upgradeCli();

  assert.deepEqual(asked(), [probe, update]);
});

test('upgrade of a CLI that came from somewhere aivi cannot ask says so, and runs nothing', t => {
  const asked = npm(t, [{ status: 1 }]);

  assert.throws(
    () => upgradeCli(),
    new Error('This CLI was not installed with a method aivi knows; update it the way you installed it.'),
  );
  assert.deepEqual(asked(), [probe]);
});
