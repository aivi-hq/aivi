import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig, reportSchema, taskSchema } from '@aivi/core';
import { loadDiscordConfig } from '../src/config.ts';

const example = resolve(import.meta.dirname, '../../../example');

// The README sends newcomers through this home; a schema change that breaks it must fail here, not on their machine.
test('the example home loads through the real loaders with every feature enabled', async () => {
  const loaded = await loadConfig(join(example, 'aivi.json'));
  assert.equal(loaded.config.stateDirectory, join(example, 'state'), 'state lives in the home');
  assert.ok(loaded.sources.length > 0);
  assert.ok(loaded.config.browser && loaded.config.search && loaded.config.modules.discord, 'everything is on');
  assert.ok(loaded.config.schedules.some(s => s.task.kind === 'dreaming'));
  const discord = await loadDiscordConfig(loaded.config.modules.discord!.config);
  assert.ok(discord.resource in loaded.config.scheduler.resources, 'Discord pool exists');
  assert.equal(discord.directory, join(example, 'librarian'));
  for (const file of await readdir(join(example, 'tasks'))) {
    const raw = JSON.parse(await readFile(join(example, 'tasks', file), 'utf8'));
    const task = 'task' in raw ? raw.task : raw;
    taskSchema.parse(task);
    if ('report' in raw) reportSchema.parse(raw.report);
  }
});
