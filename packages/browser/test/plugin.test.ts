/** How the browser plugin builds its module from a block: the paths of a
 *  connection are resolved against the home, and an attached browser has none.
 *  `./module.ts` is a module mock (it is the browser machinery's door),
 *  registered before the plugin's config is imported. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const built = { id: 'browser' };
const createBrowserModule = mock.fn((_config: unknown) => built);
mock.module('../src/module.ts', { exports: { createBrowserModule } });

const { plugin, browserConfigSchema } = await import('../src/config.ts');

/** The config the module was last built with. */
const lastBuilt = () => createBrowserModule.mock.calls.at(-1)!.arguments[0];

test('an attached browser has no path to resolve: the module gets the block as it is', async () => {
  const config = browserConfigSchema.parse({ connection: { mode: 'attach', browserUrl: 'http://127.0.0.1:9222' } });

  assert.equal(await plugin.createModule(config, '/aivi-home'), built);

  assert.equal(lastBuilt(), config);
});

test('a launched browser has its profile directory and its executable resolved against the home', async () => {
  const config = browserConfigSchema.parse({
    connection: { mode: 'launch', userDataDir: 'chrome-profile', executablePath: 'bin/chrome' },
  });

  await plugin.createModule(config, '/aivi-home');

  assert.deepEqual(lastBuilt(), {
    ...config,
    connection: {
      mode: 'launch',
      headless: false,
      userDataDir: '/aivi-home/chrome-profile',
      executablePath: '/aivi-home/bin/chrome',
    },
  });
});

test('a launch with no executable names none, and an absolute profile directory stays where it is', async () => {
  const config = browserConfigSchema.parse({ connection: { mode: 'launch', userDataDir: '/srv/profile' } });

  await plugin.createModule(config, '/aivi-home');

  assert.deepEqual(lastBuilt(), {
    ...config,
    connection: { mode: 'launch', headless: false, userDataDir: '/srv/profile' },
  });
});

test('an existing browser’s profile directory is resolved against the home', async () => {
  const config = browserConfigSchema.parse({ connection: { mode: 'existing', userDataDir: 'chrome-profile' } });

  await plugin.createModule(config, '/aivi-home');

  assert.deepEqual(lastBuilt(), {
    ...config,
    connection: { mode: 'existing', userDataDir: '/aivi-home/chrome-profile' },
  });
});
