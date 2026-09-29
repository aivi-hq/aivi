import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { deleteConfigBlock, envFileKeys, upsertEnvFile, writeConfigBlock } from '../src/config-write.ts';

let directory: string;

beforeEach(() => {
  directory = join(tmpdir(), `aivi-config-write-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const configPath = () => join(directory, 'config.json');

function seedConfig(): void {
  writeFileSync(
    configPath(),
    `${JSON.stringify({ version: 1, identity: { name: 'Clawd' }, plugins: { alpha: { agent: 'old' } } }, null, 2)}\n`,
  );
}

test('writeConfigBlock writes one nested block and keeps the rest of the file', async () => {
  seedConfig();
  await writeConfigBlock(configPath(), ['plugins', 'alpha'], {
    applicationId: '10000000000000001',
    access: { channels: [] },
  });
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as {
    identity: { name: string };
    plugins: { alpha: { applicationId: string } };
  };
  assert.equal(raw.identity.name, 'Clawd', 'untouched blocks keep their bytes');
  assert.equal(raw.plugins.alpha.applicationId, '10000000000000001', 'the old block is replaced whole');
});

test('writeConfigBlock creates intermediate objects in a bare config', async () => {
  writeFileSync(configPath(), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  await writeConfigBlock(configPath(), ['plugins', 'beta'], { access: { channels: [] } });
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as { plugins: { beta: unknown } };
  assert.ok(raw.plugins.beta);
});

test('writeConfigBlock restores the old bytes when the result does not load', async () => {
  seedConfig();
  const before = readFileSync(configPath(), 'utf8');
  await assert.rejects(
    // `port: 'x'` is not a number: loadConfig must refuse, so the write is undone.
    // A plugin block's own contents are not core's to refuse — the composed
    // schema is the plugin's business; core's fields keep the guarantee.
    writeConfigBlock(configPath(), ['host', 'port'], 'x'),
    /port/,
  );
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'the previous bytes are back');
  await assert.rejects(
    // a block key that is not a module id fails even the open schema.
    writeConfigBlock(configPath(), ['plugins', 'Bad Id'], {}),
    /plugins/,
  );
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'a rejected block key is undone too');
});

test('writeConfigBlock refuses an empty or malformed path', async () => {
  seedConfig();
  await assert.rejects(writeConfigBlock(configPath(), [], {}), /path/);
  await assert.rejects(writeConfigBlock(configPath(), ['plugins', ''], {}), /path/);
});

test('deleteConfigBlock drops one block and keeps the rest', async () => {
  seedConfig();
  assert.equal(await deleteConfigBlock(configPath(), ['plugins', 'alpha']), true);
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as {
    version: number;
    identity: { name: string };
    plugins: Record<string, unknown>;
  };
  assert.equal('alpha' in raw.plugins, false, 'the block is gone');
  assert.equal(raw.identity.name, 'Clawd', 'everything else keeps its bytes');
});

test('deleteConfigBlock answers false for an absent path and writes nothing', async () => {
  seedConfig();
  const before = readFileSync(configPath(), 'utf8');
  assert.equal(await deleteConfigBlock(configPath(), ['plugins', 'beta']), false, 'no such block');
  assert.equal(await deleteConfigBlock(configPath(), ['nowhere', 'beta']), false, 'no such parent');
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'an absent path is not a write');
});

test('deleteConfigBlock restores the old bytes when the result does not load', async () => {
  seedConfig();
  const before = readFileSync(configPath(), 'utf8');
  await assert.rejects(deleteConfigBlock(configPath(), ['version']), /version/);
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'a required field cannot be deleted away');
});

test('deleteConfigBlock refuses an empty or malformed path', async () => {
  seedConfig();
  await assert.rejects(deleteConfigBlock(configPath(), []), /path/);
  await assert.rejects(deleteConfigBlock(configPath(), ['plugins', '']), /path/);
});

test('upsertEnvFile replaces a key in place and appends a missing one', () => {
  const path = join(directory, '.env');
  writeFileSync(path, '# secrets\nDISCORD_BOT_TOKEN=old\nOTHER=keep\n');
  upsertEnvFile(path, 'DISCORD_BOT_TOKEN', 'new');
  const lines = readFileSync(path, 'utf8').split('\n');
  assert.deepEqual(lines, ['# secrets', 'DISCORD_BOT_TOKEN=new', 'OTHER=keep', '']);
  upsertEnvFile(path, 'SLACK_BOT_TOKEN', 'xoxb-1');
  const again = readFileSync(path, 'utf8').split('\n');
  assert.equal(again.includes('SLACK_BOT_TOKEN=xoxb-1'), true);
  assert.equal(again.includes('DISCORD_BOT_TOKEN=new'), true, 'the earlier upsert survived');
});

test('upsertEnvFile creates the file when absent, and always 0600', () => {
  const path = join(directory, '.env');
  upsertEnvFile(path, 'DISCORD_BOT_TOKEN', 't');
  assert.equal(readFileSync(path, 'utf8'), 'DISCORD_BOT_TOKEN=t\n');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'a secret file is owner-only');
  writeFileSync(path, 'DISCORD_BOT_TOKEN=t\n', { mode: 0o644 });
  upsertEnvFile(path, 'DISCORD_BOT_TOKEN', 't2');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'a loosened mode is tightened again');
});

test('upsertEnvFile keeps a file that does not end in a newline well-formed', () => {
  const path = join(directory, '.env');
  writeFileSync(path, 'A=1');
  upsertEnvFile(path, 'B', '2');
  assert.equal(readFileSync(path, 'utf8'), 'A=1\nB=2\n');
});

test('upsertEnvFile refuses a non-name key', () => {
  const path = join(directory, '.env');
  assert.throws(() => upsertEnvFile(path, 'not a name', 'v'), /environment variable/);
});

test('envFileKeys lists the names a file defines, absent file is empty', () => {
  const path = join(directory, '.env');
  assert.deepEqual(envFileKeys(path), []);
  writeFileSync(path, 'A=1\n# comment\nB=2\n');
  assert.deepEqual(envFileKeys(path), ['A', 'B']);
});
