import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig, reportSchema, taskSchema } from '@aivi/core';
import { loadDiscordConfig } from '../src/config.ts';

const examples = resolve(import.meta.dirname, '../../../examples');

// The README sends newcomers through these files; a schema change that breaks one must fail here, not on their machine.
test('every example configuration loads through the real loaders', async () => {
  const files = (await readdir(examples)).filter(f => f.startsWith('aivi') && f.endsWith('.json'));
  assert.ok(files.length >= 3, `expected the aivi*.json examples, found ${files.join(', ')}`);
  for (const file of files) {
    const loaded = await loadConfig(join(examples, file));
    assert.ok(loaded.sources.length > 0, `${file} configures knowledge sources`);
    if (loaded.config.modules.discord) {
      const discord = await loadDiscordConfig(loaded.config.modules.discord.config);
      assert.ok(discord.resource in loaded.config.scheduler.resources, `${file}: Discord pool exists`);
    }
  }
  for (const file of await readdir(join(examples, 'tasks'))) {
    const raw = JSON.parse(await readFile(join(examples, 'tasks', file), 'utf8'));
    const task = 'task' in raw ? raw.task : raw;
    taskSchema.parse(task);
    if ('report' in raw) reportSchema.parse(raw.report);
  }
});
