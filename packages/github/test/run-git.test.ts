/** `runGit`: the one place the GitHub plugins cross to disk, and what it makes of git's answer.
 *  `execFile` is what it reaches, and `github.ts` promisifies it when it loads, so the stand-in
 *  is put in place before the module is imported. It is a `mock.fn` over a plain function, not a
 *  `mock.method` of the real `execFile`: that one would still carry the real function's own
 *  `promisify` hook, and `runGit` would spawn git. */

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { after, mock, test } from 'node:test';

type Done = (error: unknown, answer?: { stdout: string; stderr: string }) => void;
const execFile = mock.fn((_file: string, _args: string[], _options: Record<string, unknown>, done: Done) =>
  done(null, { stdout: '', stderr: '' }),
);
mock.property(childProcess, 'execFile', execFile as unknown as typeof childProcess.execFile);
syncBuiltinESMExports();
after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

const { runGit } = await import('../src/github.ts');

/** What git said to the last call, through the callback `execFile` ends with. */
const git = (say: (done: Done) => void) =>
  execFile.mock.mockImplementationOnce((_file, _args, _options, done) => say(done));

test('git is run in the directory it was asked about, and its output is handed back trimmed', async () => {
  git(done => done(null, { stdout: ' abc123\n', stderr: '' }));

  assert.deepEqual(await runGit('/work/site', ['rev-parse', 'HEAD']), { ok: true, stdout: 'abc123' });

  const [file, args, options] = execFile.mock.calls.at(-1)!.arguments;
  assert.equal(file, 'git');
  assert.deepEqual(args, ['-C', '/work/site', 'rev-parse', 'HEAD']);
  assert.equal(options.maxBuffer, 4 * 1024 * 1024);
  assert.equal(options.signal, undefined, 'no signal unless the caller brought one');
  const env = options.env as Record<string, string>;
  assert.equal(env.GIT_TERMINAL_PROMPT, '0', 'git never stops to ask a question nobody will answer');
  assert.equal(env.PATH, process.env.PATH, 'the rest of the environment is the process’s own');
});

test('the credential the caller carries goes in the environment, beside the caller’s abort signal', async () => {
  const signal = new AbortController().signal;
  git(done => done(null, { stdout: '', stderr: '' }));

  await runGit('/work/site', ['fetch'], { env: { GIT_CONFIG_COUNT: '1', GIT_TERMINAL_PROMPT: '1' }, signal });

  const [, args, options] = execFile.mock.calls.at(-1)!.arguments;
  assert.deepEqual(args, ['-C', '/work/site', 'fetch'], 'nothing secret rides in argv');
  const env = options.env as Record<string, string>;
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '1', 'what the caller sets wins over the default');
  assert.equal(options.signal, signal);
});

test('a failed git says what it said, else what the failure was, else whatever was thrown', async () => {
  for (const [thrown, said] of [
    [
      Object.assign(new Error('Command failed: git push'), { stderr: ' fatal: Authentication failed\n' }),
      'fatal: Authentication failed',
    ],
    [Object.assign(new Error(' spawn git ENOENT '), { stderr: '' }), 'spawn git ENOENT'],
    ['git is gone', 'git is gone'],
  ] as const) {
    git(done => done(thrown));

    assert.deepEqual(await runGit('/work/site', ['push']), { ok: false, message: said });
  }
});
