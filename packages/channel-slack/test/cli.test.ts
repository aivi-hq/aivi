/** The Slack module's `manifest` command, played against a recorded context. It is the
 *  command that runs before the module exists, so its prefix comes from the config, from
 *  `--prefix`, or from a prompt when neither names one. `status` and `resolve` are the
 *  shared inbox commands and are tested with every adapter in `plugin/test/cli.test.ts`. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { cliFixture } from '../../plugin/test/cli-fixture.ts';
import { cancelSetup, setupFixture } from '../../plugin/test/setup-fixture.ts';
import cli from '../src/cli.ts';

interface Manifest {
  display_information: { name: string };
  features: { slash_commands: { command: string }[] };
}

/** Whether stdin is a terminal for this test, so the unconfigured path may ask. */
function terminal(t: TestContext, tty: boolean): void {
  const before = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  t.after(() => {
    if (before) Object.defineProperty(process.stdin, 'isTTY', before);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
  });
}

/** What a command leaves behind when it ends unsaid: the exit code is the only trace. */
function exitCode(t: TestContext): void {
  const before = process.exitCode;
  t.after(() => {
    process.exitCode = before;
  });
}

const prefixes = (manifest: unknown) =>
  (manifest as Manifest).features.slash_commands.map(command => command.command.split('-')[0]);

test('manifest: a configured module prints its own prefix under the persona name, as raw JSON', async () => {
  const slack = cliFixture(cli, { plugins: { 'channel-slack': { commandPrefix: 'spider' } }, identityName: 'Clawd' });

  await slack.run('manifest');

  const manifest = slack.printed[0] as Manifest;
  assert.equal(manifest.display_information.name, 'Clawd');
  assert.deepEqual(new Set(prefixes(manifest)), new Set(['/spider']));
  assert.deepEqual(slack.said, [[{ type: 'json', value: manifest }]], 'a terminal gets the raw text to paste');
});

test('manifest: --prefix overrides the configured prefix', async () => {
  const slack = cliFixture(cli, { plugins: { 'channel-slack': { commandPrefix: 'spider' } } });

  await slack.run('manifest', '--prefix', 'bot');

  assert.deepEqual(new Set(prefixes(slack.printed[0])), new Set(['/bot']));
});

test('manifest: with no prefix anywhere and no terminal to ask on, the command says what to pass', async t => {
  terminal(t, false);
  const prompts = setupFixture(t);
  const slack = cliFixture(cli, { prompts: prompts.ctx.prompts });

  await assert.rejects(slack.run('manifest'), /Slack is not configured yet; provide the prefix/);

  assert.equal(prompts.ask.mock.callCount(), 0, 'nothing is asked of a pipe');
  assert.deepEqual(slack.printed, []);
});

test('manifest: an unconfigured home on a terminal is asked for the prefix; blank means the default', async t => {
  terminal(t, true);
  for (const [answer, prefix] of [
    ['bot', '/bot'],
    ['  ', '/aivi'],
  ] as const) {
    await t.test(`answered ${JSON.stringify(answer)}`, async () => {
      const prompts = setupFixture(t, [answer]);
      const slack = cliFixture(cli, { prompts: prompts.ctx.prompts });

      await slack.run('manifest');

      assert.deepEqual(new Set(prefixes(slack.printed[0])), new Set([prefix]));
      assert.equal(prompts.questions.length, 1);
    });
  }
});

test('manifest: the prefix prompt lets blank through and refuses anything a slash command cannot be', async t => {
  terminal(t, true);
  const prompts = setupFixture(t, ['aivi']);
  await cliFixture(cli, { prompts: prompts.ctx.prompts }).run('manifest');

  const { message, validate } = prompts.questions[0]!;

  assert.match(message, /Slash command prefix/);
  for (const accepted of [undefined, '', '  ', 'bot', 'my-bot_2'])
    assert.equal(validate!(accepted), undefined, `${JSON.stringify(accepted)} is a prefix, or blank`);
  for (const refused of ['Bot', '2bot', 'my bot'])
    assert.equal(validate!(refused), 'Lowercase letters, digits, _ or -', `${refused} cannot head /<prefix>-new`);
});

test('manifest: a cancelled or empty answer ends the command unsaid, with a failing exit code', async t => {
  terminal(t, true);
  exitCode(t);
  for (const answer of [cancelSetup, undefined]) {
    process.exitCode = undefined;
    const prompts = setupFixture(t, [answer]);
    const slack = cliFixture(cli, { prompts: prompts.ctx.prompts });

    await slack.run('manifest');

    assert.equal(process.exitCode, 1);
    assert.deepEqual(slack.printed, [], 'no manifest is printed for an answer that is not one');
  }
});
