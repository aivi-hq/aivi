/** The package entry: what `@aivi/forge-github` hands to the host and to other plugins. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as entry from '../src/index.ts';

test('the package exposes its forge, its module and plugin entry, the remote helpers and the project-name rule', () => {
  assert.deepEqual(Object.keys(entry).sort(), [
    'GITHUB_HOST',
    'GitHubForge',
    'createForgeGithubModule',
    'createGitHubForge',
    'forgeGithubSchema',
    'httpsRemote',
    'isGitHub',
    'parseRemote',
    'plugin',
    'suggestedProjectId',
  ]);
  assert.equal(entry.plugin.id, 'forge-github');
  assert.equal(entry.createForgeGithubModule().id, 'forge-github');
});
