/** `aivi discord register`: the slash commands of the configured application,
 *  registered on demand. The command's own code is what runs; the module that
 *  talks to Discord is replaced (it is the package's own door to `discord.js`,
 *  and what it sends is `module.test.ts`'s subject), and the context is the
 *  plugin kit's recorded one. `status` and `resolve` are the plugin kit's
 *  shared inbox test. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { cliFixture } from '../../plugin/test/cli-fixture.ts';

const registerDiscordCommands = mock.fn(async (_config: unknown) => {});
mock.module('../src/index.ts', { exports: { registerDiscordCommands } });

const { default: discordCommand } = await import('../src/cli.ts');

const block = { applicationId: '10000000000000001', agent: 'assistant', directory: '/home/projects/site' };

test('register puts the slash commands of the configured application to Discord and says it did', async () => {
  registerDiscordCommands.mock.resetCalls();
  const cli = cliFixture(discordCommand, { plugins: { 'channel-discord': block } });

  await cli.run('register');

  assert.deepEqual(
    registerDiscordCommands.mock.calls.map(call => call.arguments),
    [[block]],
  );
  assert.deepEqual(cli.printed, [{ registered: true }]);
});

test('register in a home where Discord is not configured says so, and asks Discord for nothing', async () => {
  registerDiscordCommands.mock.resetCalls();
  const cli = cliFixture(discordCommand);

  await assert.rejects(cli.run('register'), /Discord is not configured in config\.json/);

  assert.equal(registerDiscordCommands.mock.callCount(), 0);
  assert.deepEqual(cli.printed, []);
});

test('register that Discord refuses fails with its reason and prints nothing', async () => {
  const refusal = new Error('401: Unauthorized');
  registerDiscordCommands.mock.mockImplementationOnce(async () => Promise.reject(refusal));
  const cli = cliFixture(discordCommand, { plugins: { 'channel-discord': block } });

  await assert.rejects(cli.run('register'), error => error === refusal);

  assert.deepEqual(cli.printed, []);
});
