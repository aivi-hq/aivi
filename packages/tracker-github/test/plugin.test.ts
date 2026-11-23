/** How the GitHub tracker plugin builds its module from its block: lazily,
 *  from `./module.ts`. That file is a module mock (it is the whole tracker's
 *  door, and the plugin's config only loads it when the host builds),
 *  registered before the plugin's config is imported. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const built = { id: 'tracker-github' };
const createGithubModule = mock.fn((_config: unknown) => built);
mock.module('../src/module.ts', { exports: { createGithubModule } });

const { githubSchema, plugin } = await import('../src/config.ts');

test('the module is built from the block it is configured with', async () => {
  const config = githubSchema.parse({ humanLabel: 'blocked' });

  assert.equal(await plugin.createModule(config, '/aivi-home'), built);

  assert.deepEqual(
    createGithubModule.mock.calls.map(call => call.arguments),
    [[config]],
  );
});
