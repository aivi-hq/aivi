import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Store } from '@aivi/host';
import { cos, VoiceStore } from '../src/store.ts';

function voiceStore(t: TestContext, path = ':memory:') {
  const database = new Store(path);
  t.after(() => database.close());
  const info = t.mock.fn<(message: string, fields?: Record<string, unknown>) => void>();
  const store = new VoiceStore(database, { info });
  // Rows come back from SQLite without a prototype; the known voices as plain facts.
  const voices = () => store.speakers().map(({ name, samples }) => ({ name, samples }));
  return { database, info, store, voices };
}

test('cosine is one for the same direction and zero for a right angle', () => {
  assert.ok(Math.abs(cos([2, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cos([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cos(new Float32Array([1, 1]), [1, 0]) - Math.SQRT1_2) < 1e-6);
});

test('a voice is learned as it is heard: matched, kept through a blip, minted when new', t => {
  const { store, voices } = voiceStore(t);
  const ada = new Float32Array([1, 0, 0, 0]);
  const nearAda = new Float32Array([0.99, 0.14, 0, 0]);
  const stranger = new Float32Array([0, 0, 1, 0]);

  assert.deepEqual(store.identify(ada, 5, 0.5), { name: 't1', score: 0, minted: true });
  const again = store.identify(nearAda, 5, 0.5);
  assert.equal(again.name, 't1');
  assert.equal(again.minted, false);
  assert.ok(again.score > 0.98);
  assert.deepEqual(
    store.identify(stranger, 1.2, 0.5).name,
    't1',
    'a blip of an unknown voice keeps the nearest label for continuity',
  );
  const fresh = store.identify(stranger, 3, 0.5);
  assert.equal(fresh.name, 't2', 'the same voice long enough is a real utterance: a new person');
  assert.equal(fresh.minted, true);
  assert.ok(Math.abs(fresh.score) < 1e-9);
  assert.deepEqual(voices(), [
    { name: 't1', samples: 2 },
    { name: 't2', samples: 1 },
  ]);
});

test('the nearest stored voice wins, whichever was heard first, and every match sharpens it', t => {
  const { store, voices } = voiceStore(t);
  store.identify(new Float32Array([1, 0]), 5, 0.5);
  store.identify(new Float32Array([0, 1]), 5, 0.5);

  const second = store.identify(new Float32Array([0.2, 0.98]), 5, 0.5);
  const first = store.identify(new Float32Array([0.98, 0.2]), 5, 0.5);
  const between = store.identify(new Float32Array([0.5, 0.86]), 5, 0.5);

  assert.equal(second.name, 't2');
  assert.equal(first.name, 't1');
  assert.equal(between.name, 't2', 'the centroid of every sample is what a voice is compared with');
  assert.deepEqual(voices(), [
    { name: 't1', samples: 2 },
    { name: 't2', samples: 3 },
  ]);
});

test('renamed voices keep their names, names without a voice match nothing, and mints never collide', t => {
  const { database, store, voices } = voiceStore(t);
  store.identify(new Float32Array([1, 0]), 5, 0.5);
  database.db.prepare("UPDATE voice_identities SET name = 'Ada' WHERE name = 't1'").run();
  database.db.prepare("INSERT INTO voice_identities(name) VALUES ('t2')").run();

  const known = store.identify(new Float32Array([1, 0.1]), 5, 0.5);
  const fresh = store.identify(new Float32Array([0, 1]), 5, 0.5);
  const next = store.identify(new Float32Array([-1, 0]), 5, 0.5);

  assert.equal(known.name, 'Ada');
  assert.equal(fresh.name, 't1', 'the freed number is the first one nobody carries');
  assert.equal(next.name, 't3', 'a name in use is skipped, with or without a voice behind it');
  assert.deepEqual(voices(), [
    { name: 'Ada', samples: 2 },
    { name: 't1', samples: 1 },
    { name: 't2', samples: 0 },
    { name: 't3', samples: 1 },
  ]);
});

test('a first voice heard only as a blip is still minted: there is no label to keep', t => {
  const { store } = voiceStore(t);

  assert.deepEqual(store.identify(new Float32Array([1, 0]), 0.5, 0.5), { name: 't1', score: 0, minted: true });
});

test('a transcript keeps its lines in order, with what the platform knew about each', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-18T10:00:00Z') });
  const { store, info } = voiceStore(t);
  const meeting = store.openTranscript('meet:standup');

  store.appendLine(meeting, 0, 2, 'Ada', 'first line');
  t.mock.timers.tick(2500);
  const addressed = store.appendLine(meeting, 2.5, 4, 'Grace', 'second line', {
    wake: true,
    user: 'u-grace',
    channel: 'c-voice',
  });
  store.appendLine(meeting, 5, 7, 'Ada', 'third line');

  assert.deepEqual(store.readLines({ last: 50 }), [
    {
      id: 1,
      transcript: meeting,
      at: '2026-11-18T10:00:00.000Z',
      t0: 0,
      t1: 2,
      speaker: 'Ada',
      text: 'first line',
      wake: false,
    },
    {
      id: addressed,
      transcript: meeting,
      at: '2026-11-18T10:00:02.500Z',
      t0: 2.5,
      t1: 4,
      speaker: 'Grace',
      text: 'second line',
      wake: true,
      user: 'u-grace',
      channel: 'c-voice',
    },
    {
      id: 3,
      transcript: meeting,
      at: '2026-11-18T10:00:02.500Z',
      t0: 5,
      t1: 7,
      speaker: 'Ada',
      text: 'third line',
      wake: false,
    },
  ]);
  assert.deepEqual(
    store.readLines({ last: 2, speaker: 'Ada' }).map(line => line.text),
    ['first line', 'third line'],
  );
  assert.deepEqual(
    store.readLines({ last: 1 }).map(line => line.text),
    ['third line'],
  );
  assert.deepEqual(info.mock.calls[1]!.arguments, [
    'voice.line',
    { transcript: meeting, t0: 2.5, t1: 4, speaker: 'Grace', wake: true },
  ]);
  assert.equal(info.mock.calls[0]!.arguments[1]?.wake, false);
});

test('transcripts are groups, newest first, and one group pages back by line id', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T09:00:00Z') });
  const { store } = voiceStore(t);
  const monday = store.openTranscript('monday.wav');
  t.mock.timers.tick(86_400_000);
  const tuesday = store.openTranscript('tuesday.wav');
  for (let i = 1; i <= 7; i++) store.appendLine(monday, i, i + 1, 't1', `line ${i}`);
  store.appendLine(tuesday, 0, 1, 't2', 'apart');

  assert.deepEqual(store.transcripts(), [
    { id: tuesday, startedAt: '2026-11-17T09:00:00.000Z', source: 'tuesday.wav', lines: 1 },
    { id: monday, startedAt: '2026-11-16T09:00:00.000Z', source: 'monday.wav', lines: 7 },
  ]);
  assert.deepEqual(
    store.transcripts(1).map(group => group.source),
    ['tuesday.wav'],
  );
  const newest = store.readLines({ transcript: monday, last: 3 });
  const older = store.readLines({ transcript: monday, last: 3, before: newest[0]!.id });
  const oldest = store.readLines({ transcript: monday, last: 3, before: older[0]!.id });
  assert.deepEqual(
    [newest, older, oldest].map(page => page.map(line => line.text)),
    [['line 5', 'line 6', 'line 7'], ['line 2', 'line 3', 'line 4'], ['line 1']],
  );
});

test('one read is bounded however much is asked for', t => {
  const { store } = voiceStore(t);
  const groups = Array.from({ length: 101 }, (_, i) => store.openTranscript(`meeting ${i}`));
  for (let i = 0; i < 501; i++) store.appendLine(groups[0]!, i, i + 1, 't1', `line ${i}`);

  assert.equal(store.transcripts(1000).length, 100);
  assert.equal(store.readLines({ last: 1000 }).length, 500);
});

test('a room remembers its session and when words last went to it', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { database, store } = voiceStore(t);
  assert.equal(store.roomSession('meet:room'), undefined, 'no session until a lease provides one');
  store.touchRoomSession('meet:room');
  assert.equal(store.roomSessionAt('meet:room'), undefined, 'a touch without a session is nothing, not a stray row');

  store.setRoomSession('meet:room', 'ses_voice_meet');
  store.setRoomSession('discord:guild', 'ses_voice_discord');
  t.mock.timers.tick(60_000);
  store.touchRoomSession('meet:room');

  assert.equal(store.roomSession('meet:room'), 'ses_voice_meet');
  assert.deepEqual(store.roomSessionAt('meet:room'), { id: 'ses_voice_meet', at: 1_060_000 });
  assert.deepEqual(
    store.roomSessionAt('discord:guild'),
    { id: 'ses_voice_discord', at: 1_000_000 },
    'another room is another conversation with its own clock',
  );
  store.setRoomSession('meet:room', 'ses_voice_next');
  assert.deepEqual(store.roomSessionAt('meet:room'), { id: 'ses_voice_next', at: 1_060_000 });
  store.clearRoomSession('meet:room');
  assert.equal(store.roomSessionAt('meet:room'), undefined, 'clearing takes the timestamp with it');
  assert.equal(store.roomSession('discord:guild'), 'ses_voice_discord');
  database.db.prepare("INSERT INTO voice_state(key, value) VALUES ('session:old-room', 'ses_voice_old')").run();
  assert.deepEqual(
    store.roomSessionAt('old-room'),
    { id: 'ses_voice_old', at: 0 },
    'a session remembered before the stamp existed is as quiet as can be',
  );
});

test('the lease a room holds is persisted until its turn gives it back', t => {
  const { store } = voiceStore(t);

  store.setRoomLease('discord:guild', 'lease-1');
  store.setRoomLease('meet:room', 'lease-2');
  store.setRoomLease('discord:guild', 'lease-3');

  assert.deepEqual(store.roomLeases(), [
    { label: 'discord:guild', leaseId: 'lease-3' },
    { label: 'meet:room', leaseId: 'lease-2' },
  ]);
  store.setRoomLease('discord:guild', null);
  store.setRoomLease('never-held', null);
  assert.deepEqual(store.roomLeases(), [{ label: 'meet:room', leaseId: 'lease-2' }]);
});

test('voices, lines and sessions survive a restart on the same database file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'aivi-voice-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'aivi.sqlite');
  const voice = new Float32Array([1, 2, 3, 4]);
  const yesterday = voiceStore(t, file).store;
  const heard = yesterday.identify(voice, 5, 0.5);
  yesterday.appendLine(yesterday.openTranscript('day one'), 0, 2, heard.name, 'the first day');
  yesterday.setRoomSession('meet:room', 'ses_voice_day_one');

  const today = voiceStore(t, file).store;
  const again = today.identify(voice, 5, 0.5);

  assert.equal(heard.minted, true);
  assert.deepEqual([again.name, again.minted], [heard.name, false], 'the person heard yesterday is that person today');
  assert.equal(today.roomSession('meet:room'), 'ses_voice_day_one');
  assert.deepEqual(
    today.readLines({ last: 10 }).map(line => line.text),
    ['the first day'],
  );
});
