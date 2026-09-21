import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig, reportSchema, taskSchema } from '@aivi/core';

const example = resolve(import.meta.dirname, '../../../example');

// The README sends newcomers through this home; a schema change that breaks it must fail here, not on their
// machine. The tests load the tracked template: the live example/config.json is the developer's own, ignored config.
test('the example home template loads through the real loaders with every feature enabled', async () => {
  const loaded = await loadConfig(join(example, 'config.example.json'));
  assert.equal(loaded.config.stateDirectory, join(example, 'state'), 'state lives in the home');
  assert.ok(loaded.sources.length > 0);
  const discord = typeof loaded.config.modules.discord === 'object' ? loaded.config.modules.discord : undefined;
  assert.ok(loaded.config.browser && loaded.config.search && discord, 'everything is on');
  assert.ok(loaded.config.jobs.some(s => s.task.kind === 'invocation' && s.task.name === 'dreaming'));
  assert.ok(discord!.resource in loaded.config.scheduler.resources, 'Discord pool exists');
  assert.equal(discord!.directory, example, 'the home is the OpenCode location');
  for (const file of await readdir(join(example, 'tasks'))) {
    const raw = JSON.parse(await readFile(join(example, 'tasks', file), 'utf8'));
    const task = 'task' in raw ? raw.task : raw;
    taskSchema.parse(task);
    if ('report' in raw) reportSchema.parse(raw.report);
  }
});
