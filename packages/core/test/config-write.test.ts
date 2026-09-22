import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { envFileKeys, upsertEnvFile, writeConfigBlock } from '../src/config-write.ts';

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
    `${JSON.stringify({ version: 1, identity: { name: 'Clawd' }, modules: { discord: false } }, null, 2)}\n`,
  );
}

test('writeConfigBlock writes one nested block and keeps the rest of the file', async () => {
  seedConfig();
  await writeConfigBlock(configPath(), ['modules', 'discord'], {
    applicationId: '10000000000000001',
    access: { channels: [] },
  });
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as {
    identity: { name: string };
    modules: { discord: { applicationId: string } };
  };
  assert.equal(raw.identity.name, 'Clawd', 'untouched blocks keep their bytes');
  assert.equal(raw.modules.discord.applicationId, '10000000000000001', 'the explicit false is replaced by the block');
});

test('writeConfigBlock creates intermediate objects in a bare config', async () => {
  writeFileSync(configPath(), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  await writeConfigBlock(configPath(), ['modules', 'slack'], { access: { channels: [] } });
  const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as { modules: { slack: unknown } };
  assert.ok(raw.modules.slack);
});

test('writeConfigBlock restores the old bytes when the result does not load', async () => {
  seedConfig();
  const before = readFileSync(configPath(), 'utf8');
  await assert.rejects(
    // `agent: 5` is not a string: loadConfig must refuse, so the write is undone.
    writeConfigBlock(configPath(), ['modules', 'discord'], { applicationId: '10000000000000001', agent: 5 }),
    /agent/,
  );
  assert.equal(readFileSync(configPath(), 'utf8'), before, 'the previous bytes are back');
});

test('writeConfigBlock refuses an empty or malformed path', async () => {
  seedConfig();
  await assert.rejects(writeConfigBlock(configPath(), [], {}), /path/);
  await assert.rejects(writeConfigBlock(configPath(), ['modules', ''], {}), /path/);
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
