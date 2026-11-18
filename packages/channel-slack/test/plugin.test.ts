/** How the Slack plugin builds its module from a block: the directory is
 *  resolved against the home. `./module.ts` is a module mock (it is the
 *  Slack SDKs' door), registered before the plugin's config is imported. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const built = { id: 'channel-slack' };
const createSlackModule = mock.fn((_config: unknown) => built);
mock.module('../src/module.ts', { exports: { createSlackModule } });

const { plugin, slackConfigSchema } = await import('../src/config.ts');

for (const [written, resolved] of [
  ['slack', '/aivi-home/slack'],
  ['/srv/slack', '/srv/slack'],
  [undefined, '/aivi-home'],
] as const) {
  test(`the module is built with its directory resolved against the home (${written ?? 'the default'})`, async () => {
    const config = slackConfigSchema.parse({ access: { channels: [] }, ...(written ? { directory: written } : {}) });

    assert.equal(await plugin.createModule(config, '/aivi-home'), built);

    assert.deepEqual(createSlackModule.mock.calls.at(-1)!.arguments, [{ ...config, directory: resolved }]);
  });
}
