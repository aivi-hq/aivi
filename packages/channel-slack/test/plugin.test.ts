/** How the Slack plugin builds its module from a block: the directory is
 *  resolved against the home. `./module.ts` is a module mock (it is the
 *  Slack SDKs' door), registered before the plugin's config is imported.
 *  One test, one import: the report holds a phantom copy of the mocked file
 *  for every import of it (`docs/testing.md`). */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const built = { id: 'channel-slack' };
const createSlackModule = mock.fn((_config: unknown) => built);
mock.module('../src/module.ts', { exports: { createSlackModule } });

const { plugin, slackConfigSchema } = await import('../src/config.ts');

test('the module is built from the block, with its directory resolved against the home', async () => {
  const config = slackConfigSchema.parse({ access: { channels: [] }, directory: 'slack' });

  assert.equal(await plugin.createModule(config, '/aivi-home'), built);

  assert.deepEqual(
    createSlackModule.mock.calls.map(call => call.arguments),
    [[{ ...config, directory: '/aivi-home/slack' }]],
  );
});
