import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { reset } from '@logtape/logtape';
import { configureLogging, errorMessage, getLogger, isTty } from '../src/log.ts';

afterEach(reset);

test('error messages retain Error messages and stringify other thrown values', () => {
  assert.equal(errorMessage(new Error('broken')), 'broken');
  assert.equal(errorMessage('broken'), 'broken');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(undefined), 'undefined');
  assert.equal(errorMessage(42), '42');
});

test('only an explicitly terminal stream is a TTY', () => {
  assert.equal(isTty(undefined), false);
  assert.equal(isTty({}), false);
  assert.equal(isTty({ isTTY: false }), false);
  assert.equal(isTty({ isTTY: true }), true);
});

test('JSON logs mirror structured fields to stderr and a newly created file, then flush on disposal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aivi-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logFile = join(directory, 'nested', 'aivi.jsonl');
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const close = await configureLogging({ level: 'info', format: 'json', logFile });
  const logger = getLogger(['aivi', 'host', 'coverage']).with({ run: 'run-1' });
  try {
    logger.debug('not written');
    logger.info('ready {item}', { item: 'queue' });
    logger.warn('retry {attempt}', { attempt: 2 });
  } finally {
    await close();
  }
  const records = lines.map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].message, 'ready "queue"');
  assert.equal(records[0].level, 'INFO');
  assert.equal(records[0].logger, 'aivi.host.coverage');
  assert.equal(records[0].run, 'run-1');
  assert.equal(records[0].item, 'queue');
  assert.equal(records[1].message, 'retry 2');
  assert.equal(records[1].level, 'WARN');
  assert.equal(records[1].attempt, 2);
  assert.deepEqual(
    readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line)),
    records,
  );
  assert.equal(process.stderr.writable, true, 'disposing logging does not close stderr');
  await close();
});

test('pretty logging honors the warn threshold without adding terminal colors to a pipe', async t => {
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stderr, 'isTTY');
  });
  const close = await configureLogging({ level: 'warn', format: 'pretty' });
  try {
    const logger = getLogger(['aivi', 'host']);
    logger.info('not written');
    logger.warn('operator attention');
    logger.error('failed');
  } finally {
    await close();
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /operator attention/);
  assert.match(lines[1]!, /failed/);
  assert.equal(lines.join('').includes('\u001b['), false);
});
