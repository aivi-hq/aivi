import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { addPluginName, dependencyNames, pluginDependencies, pluginNames, removePluginName } from '../src/manifest.ts';

let appDir: string;

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'aivi-manifest-'));
});

afterEach(() => rmSync(appDir, { recursive: true, force: true }));

function seed(manifest: Record<string, unknown>): string {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(appDir, 'package.json'), text);
  return text;
}

test('plugin names include disabled tuples, but not malformed names', () => {
  seed({ 'aivi-plugins': ['@aivi/voice', ['@aivi/channel-slack', false], null, 7, [], [false, false]] });
  assert.deepEqual(pluginNames(appDir), ['@aivi/voice', '@aivi/channel-slack']);
});

test('missing or non-array plugin lists read as empty and can receive their first plugin', () => {
  for (const manifest of [{}, { 'aivi-plugins': 'broken' }]) {
    seed(manifest);
    assert.deepEqual(pluginNames(appDir), []);
    assert.equal(removePluginName(appDir, '@aivi/voice'), false);
    assert.equal(addPluginName(appDir, '@aivi/voice'), true);
    assert.deepEqual(pluginNames(appDir), ['@aivi/voice']);
  }
});

test('adding a plugin preserves existing entries and unrelated manifest fields', () => {
  const dependencies = { '@aivi/host': '1.0.0', '@aivi/voice': '1.0.0' };
  seed({ private: true, dependencies, 'aivi-plugins': [['@aivi/channel-slack', false]] });
  writeFileSync(join(appDir, 'package.json.aivi-tmp'), 'an interrupted write');
  assert.equal(addPluginName(appDir, '@aivi/voice'), true);
  assert.deepEqual(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')), {
    private: true,
    dependencies,
    'aivi-plugins': [['@aivi/channel-slack', false], '@aivi/voice'],
  });
  assert.equal(existsSync(join(appDir, 'package.json.aivi-tmp')), false);
});

test('adding an already listed plugin, enabled or disabled, writes nothing', () => {
  for (const entry of ['@aivi/voice', ['@aivi/voice', false]]) {
    const text = seed({ 'aivi-plugins': [entry] });
    assert.equal(addPluginName(appDir, '@aivi/voice'), false);
    assert.equal(readFileSync(join(appDir, 'package.json'), 'utf8'), text);
    assert.equal(existsSync(join(appDir, 'package.json.aivi-tmp')), false);
  }
});

test('removing a name drops all its entry forms but leaves dependencies and other entries alone', () => {
  const dependencies = { '@aivi/voice': '1.0.0' };
  seed({ dependencies, 'aivi-plugins': ['@aivi/voice', ['@aivi/voice', false], '@aivi/channel-slack'] });
  assert.equal(removePluginName(appDir, '@aivi/voice'), true);
  assert.deepEqual(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')), {
    dependencies,
    'aivi-plugins': ['@aivi/channel-slack'],
  });
  const text = readFileSync(join(appDir, 'package.json'), 'utf8');
  assert.equal(removePluginName(appDir, '@aivi/voice'), false);
  assert.equal(readFileSync(join(appDir, 'package.json'), 'utf8'), text);
});

test('dependency names preserve npm order while plugin dependencies omit the server', () => {
  seed({ dependencies: { '@aivi/voice': '1.0.0', '@aivi/host': '1.0.0', '@acme/plugin': '2.0.0' } });
  assert.deepEqual(dependencyNames(appDir), ['@aivi/voice', '@aivi/host', '@acme/plugin']);
  assert.deepEqual(pluginDependencies(appDir), ['@aivi/voice', '@acme/plugin']);
  seed({});
  assert.deepEqual(dependencyNames(appDir), []);
  assert.deepEqual(pluginDependencies(appDir), []);
});

test('an unreadable manifest is an error, not an empty install record', () => {
  assert.throws(() => pluginNames(appDir), { code: 'ENOENT' });
  writeFileSync(join(appDir, 'package.json'), '{broken');
  assert.throws(() => addPluginName(appDir, '@aivi/voice'), SyntaxError);
  assert.equal(readFileSync(join(appDir, 'package.json'), 'utf8'), '{broken');
});
