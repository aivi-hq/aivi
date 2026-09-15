import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '@aivi/core';
import { loadSlackConfig } from '../src/config.ts';

const example = resolve(import.meta.dirname, '../../../example');

test('the example home enables Slack with placeholder ids that load through the real loaders', async () => {
  const loaded = await loadConfig(join(example, 'aivi.json'));
  assert.ok(loaded.config.modules.slack, 'Slack is on');
  const slack = await loadSlackConfig(loaded.config.modules.slack!.config);
  assert.ok(slack.resource in loaded.config.scheduler.resources, 'Slack pool exists');
  assert.equal(slack.directory, example, 'the home is the OpenCode location');
  assert.equal(slack.commandPrefix, 'aivi');
  assert.ok(slack.reportChannels.length > 0);
});
