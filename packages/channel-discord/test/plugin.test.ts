/** How the Discord plugin builds its module from a block, with the directory
 *  resolved against the home. `./module.ts` is a module mock (it is
 *  discord.js's door), registered before the plugin's config is imported. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const built = { id: 'channel-discord' };
const createDiscordModule = mock.fn((_config: unknown) => built);
mock.module('../src/module.ts', { exports: { createDiscordModule } });

const { plugin, discordConfigSchema } = await import('../src/config.ts');

test('the module is built from the block, with its directory resolved against the home', async () => {
  const block = { applicationId: '123456789012345678', access: { channels: [] } };
  const relative = discordConfigSchema.parse({ ...block, directory: 'discord' });
  const absolute = discordConfigSchema.parse({ ...block, directory: '/srv/discord' });

  assert.equal(await plugin.createModule(relative, '/aivi-home'), built);
  assert.equal(await plugin.createModule(absolute, '/aivi-home'), built);

  assert.deepEqual(
    createDiscordModule.mock.calls.map(call => call.arguments),
    [[{ ...relative, directory: '/aivi-home/discord' }], [{ ...absolute, directory: '/srv/discord' }]],
  );
});
