import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '@aivi/core';

const example = resolve(import.meta.dirname, '../../../example');

// The tests load the tracked template, never the developer's own git-ignored example/config.json.
test('the example home template enables Slack with placeholder ids that load through the real loaders', async () => {
  const loaded = await loadConfig(join(example, 'config.example.json'));
  const slack = typeof loaded.config.modules.slack === 'object' ? loaded.config.modules.slack : undefined;
  assert.ok(slack, 'Slack is on');
  assert.ok(slack.resource in loaded.config.scheduler.resources, 'Slack pool exists');
  assert.equal(slack.directory, example, 'the home is the OpenCode location');
  assert.equal(slack.commandPrefix, 'aivi');
  assert.ok(slack.reportChannels.length > 0);
});
