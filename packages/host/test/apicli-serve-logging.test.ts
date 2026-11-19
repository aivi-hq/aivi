/** What `serve` does with its logging options: the hook that configures
 *  logging before the command runs. `configureLogging` and `isTty` are module
 *  mocks, so what the hook decided is read from the call, and nothing wires
 *  LogTape or touches a log file. The remote guard stops `serve` right after
 *  the hook, so no host is ever started. */
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { Command } from 'commander';

const close = mock.fn(async () => {});
const configureLogging = mock.fn(async (_options: unknown) => close);
const isTty = mock.fn((_stream: unknown) => false);
const core = await import('@aivi/core');
mock.module('@aivi/core', { exports: { ...core, configureLogging, isTty } });
mock.module('../src/cli/commands/channels.ts', { exports: { registerChannels: async () => {} } });

const { registerCommands } = await import('../src/cli.ts');

const homeBefore = process.env.AIVI_HOME;
before(() => {
  process.env.AIVI_HOME = '/aivi-home';
});
after(() => {
  if (homeBefore === undefined) delete process.env.AIVI_HOME;
  else process.env.AIVI_HOME = homeBefore;
});
beforeEach(() => {
  configureLogging.mock.resetCalls();
  isTty.mock.resetCalls();
  isTty.mock.mockImplementation(() => false);
});

/** `aivi serve …` over a tree mounted the way the bin mounts it, as the far end of an exec session. */
async function serve(...options: string[]): Promise<void> {
  const program = new Command('aivi').exitOverride();
  await registerCommands(program, { remote: true });
  await program.parseAsync(['serve', ...options], { from: 'user' });
}

const logFile = '/aivi-home/state/logs/aivi.log';
const guard = /serve is not a command over the channel/;

test('serve logs at info as JSON lines when stderr is no terminal, to the home’s log file', async () => {
  await assert.rejects(serve(), guard);
  assert.deepEqual(configureLogging.mock.calls[0]!.arguments, [{ level: 'info', format: 'json', logFile }]);
  assert.equal(isTty.mock.calls[0]!.arguments[0], process.stderr);
});

test('serve logs pretty when stderr is a terminal, unless the format was named', async () => {
  isTty.mock.mockImplementation(() => true);
  await assert.rejects(serve(), guard);
  await assert.rejects(serve('--log-format', 'auto'), guard);
  await assert.rejects(serve('--log-format', 'json'), guard);
  assert.deepEqual(
    configureLogging.mock.calls.map(call => call.arguments),
    [
      [{ level: 'info', format: 'pretty', logFile }],
      [{ level: 'info', format: 'pretty', logFile }],
      [{ level: 'info', format: 'json', logFile }],
    ],
  );
});

test('serve takes the level and the format it is told, whatever the terminal says', async () => {
  await assert.rejects(serve('--log-level', 'debug', '--log-format', 'pretty'), guard);
  assert.deepEqual(configureLogging.mock.calls[0]!.arguments, [{ level: 'debug', format: 'pretty', logFile }]);
  assert.equal(isTty.mock.callCount(), 0, 'a named format needs no look at the terminal');
});

test('serve refuses a level or a format it does not know before it logs anything', async () => {
  await assert.rejects(serve('--log-level', 'loud'), /Unknown log level: loud\. Use debug, info, warn, or error\./);
  await assert.rejects(serve('--log-format', 'xml'), /Unknown log format: xml\. Use auto, pretty, json\./);
  assert.equal(configureLogging.mock.callCount(), 0);
});
