import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Store } from '@aivi/host';
import { BatchEngineRun, samplesToBase64 } from '../src/batch.ts';
import { voiceConfigSchema } from '../src/config.ts';
import { EngineRun } from '../src/engine.ts';
import { MixedFusion } from '../src/fusion.ts';
import { HearingRoom } from '../src/room.ts';
import { SharedEngine } from '../src/shared.ts';
import { cos, VoiceStore } from '../src/store.ts';
import { TtsRun } from '../src/tts.ts';
import { VoiceTurns } from '../src/turns.ts';
import { normalize, scanWake, stripWake } from '../src/wake.ts';

const quiet = { info() {}, warn() {} };
// An event bus with no listeners yet: turns only watches when a room is
// listening for streamed answer text, so plain turn tests need no stream.
const noEvents = { watch: () => () => {} };

test('wake scan is normalized, whole-word, and strippable', () => {
  assert.equal(normalize('  AÎvi, even *rustig* door!  '), 'aivi even rustig door');
  assert.equal(scanWake('goeiedag aivi kun je', ['aivi']), 'aivi');
  assert.equal(scanWake('snavi niet', ['aivi']), null); // whole words only
  assert.equal(scanWake('goeiedag Aivi, kun je', ['aivi']), 'aivi'); // case and comma
  assert.equal(stripWake('Goeiedag aivi, kun je dit nabellen?', 'aivi'), 'Goeiedag, kun je dit nabellen?');
});

test('config: rooms declare their kind; defaults and the loud monologue rule', () => {
  const engine = { command: 'true' };
  // a meeting room carries mixed anonymous audio: a meeting without person
  // memory is a monologue, and the config says so
  assert.throws(() => voiceConfigSchema.parse({ asr: engine, room: { type: 'file', path: 'x.wav', mode: 'meeting' } }));
  const ok = voiceConfigSchema.parse({
    asr: engine,
    room: { type: 'file', path: 'x.wav', mode: 'meeting' },
    identity: { model: 'm.onnx' },
  });
  assert.equal(ok.room?.mode, 'meeting');
  assert.deepEqual(ok.wake.phrases, ['hey assistant', 'hello assistant']);
  assert.equal(ok.identity?.threshold, 0.5);
  assert.equal(ok.resumeMinutes, 30, 'rejoin within half an hour resumes; past it, fresh');
  assert.equal(voiceConfigSchema.parse({ asr: engine, resumeMinutes: false }).resumeMinutes, false);
  assert.equal(voiceConfigSchema.safeParse({ asr: engine, resumeMinutes: -1 }).success, false);
  assert.equal(ok.pool, undefined); // absent: the dispatcher's default pool
  // a call room needs nothing but the engine — and call is the kind a room
  // gets when it says nothing (ruled 2026-10-13: least painful, loads least)
  const call = voiceConfigSchema.parse({ asr: engine, room: { type: 'file', path: 'x.wav' } });
  assert.equal(call.room?.mode, 'call', 'a room that declares nothing is a call');
  assert.equal(call.directory, '.');
  // the voice block carries neither mode nor agent: both belong to rooms
  assert.equal(voiceConfigSchema.safeParse({ mode: 'meeting', asr: engine }).success, false);
  assert.equal(voiceConfigSchema.safeParse({ agent: 'assistant', asr: engine }).success, false);
});

test('identity store learns as it goes: match, continuity blip, fresh mint', () => {
  const store = new VoiceStore(new Store(':memory:') as never, quiet);
  const a = new Float32Array([1, 0, 0, 0]);
  const b = new Float32Array([0, 0, 1, 0]);
  const nearA = new Float32Array([0.99, 0.14, 0, 0]);
  assert.deepEqual(store.identify(a, 5, 0.5), { name: 't1', score: 0, minted: true });
  const again = store.identify(nearA, 5, 0.5);
  assert.equal(again.name, 't1');
  assert.equal(again.minted, false);
  // a short blip of an unknown voice keeps the nearest label (continuity)
  assert.equal(store.identify(b, 1.2, 0.5).name, 't1');
  // the same blip long enough is a real utterance: a new voice
  const fresh = store.identify(b, 3, 0.5);
  assert.equal(fresh.name, 't2');
  assert.equal(fresh.minted, true);
  assert.ok(Math.abs(fresh.score) < 1e-9);
  assert.deepEqual(
    store.speakers().map(s => s.name),
    ['t1', 't2'],
  );
});

test('transcript: append, read back in order, filter by speaker', () => {
  const store = new VoiceStore(new Store(':memory:') as never, quiet);
  const tr = store.openTranscript('test.wav');
  store.appendLine(tr, 0, 2, 't1', 'eerste regel');
  store.appendLine(tr, 2.5, 4, 't2', 'tweede regel', { wake: true, user: '42', channel: '77' });
  store.appendLine(tr, 5, 7, 't1', 'derde regel');
  const lines = store.readLines({ last: 50 });
  assert.deepEqual(
    lines.map(l => l.text),
    ['eerste regel', 'tweede regel', 'derde regel'],
  );
  assert.equal(lines[1]?.wake, true);
  assert.equal(lines[1]?.user, '42');
  assert.equal(lines[1]?.channel, '77');
  assert.equal(lines[0]?.user, undefined);
  assert.deepEqual(
    store.readLines({ last: 2, speaker: 't1' }).map(l => l.text),
    ['eerste regel', 'derde regel'],
  );
  assert.deepEqual(
    store.readLines({ last: 1 }).map(l => l.text),
    ['derde regel'],
  );
});

test('a room remembers its dispatcher-minted session; leases persist for recovery', () => {
  const store = new VoiceStore(new Store(':memory:') as never, quiet);
  assert.equal(store.roomSession('meet:room456'), undefined, 'no session until a lease provides one');
  store.setRoomSession('meet:room456', 'ses_voice_ab12');
  assert.equal(store.roomSession('meet:room456'), 'ses_voice_ab12');
  // another room is another conversation
  store.setRoomSession('discord:123456789012345678', 'ses_voice_cd34');
  assert.notEqual(store.roomSession('discord:123456789012345678'), store.roomSession('meet:room456'));
  // the lease an interrupted turn left behind is what startup releases
  store.setRoomLease('discord:123456789012345678', 'le_7');
  assert.deepEqual(store.roomLeases(), [{ label: 'discord:123456789012345678', leaseId: 'le_7' }]);
  store.setRoomLease('discord:123456789012345678', null);
  assert.deepEqual(store.roomLeases(), []);
});

test('cosine of unit-ish vectors', () => {
  assert.ok(Math.abs(cos([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cos([1, 0], [0, 1])) < 1e-9);
});

test('voices survive a restart: same file, same people, same session', () => {
  const file = join(tmpdir(), `aivi-voice-db-${process.pid}.sqlite`);
  const vec = new Float32Array([1, 2, 3, 4]);
  const store = new VoiceStore(new Store(file) as never, quiet);
  const first = store.identify(vec, 5, 0.5);
  assert.equal(first.minted, true);
  const tr = store.openTranscript('day1.wav');
  store.appendLine(tr, 0, 2, first.name, 'eerste dag');
  store.setRoomSession('day1.wav', 'ses_voice_day1');

  // A new day: the database reopens and the person heard yesterday is that
  // person today — the recognition requirement at its real boundary.
  const next = new VoiceStore(new Store(file) as never, quiet);
  const again = next.identify(vec, 5, 0.5);
  assert.equal(again.name, first.name);
  assert.equal(again.minted, false);
  assert.equal(next.roomSession('day1.wav'), 'ses_voice_day1');
  assert.deepEqual(
    next.readLines({ last: 10 }).map(l => l.text),
    ['eerste dag'],
  );
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});

// Engine wiring against a stub that speaks the protocol — no models, no MLX,
// and no ffmpeg: the audio is a stream the test hands over, so the unit under
// test is the engine protocol, not a decoder.
test('EngineRun: ready on marker, events parsed, ring slices the feed', async () => {
  const dir = join(tmpdir(), `aivi-voice-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });

  // The stub reads the whole feed, then replays a protocol session — events
  // arrive only after the audio has fully flowed, so the ring is provably
  // filled when the eof event lands. No timers on either side.
  const stub = join(dir, 'stub.mjs');
  writeFileSync(
    stub,
    `process.stderr.write('stub engine ready\\n');
     process.stdin.on('data', () => {});
     process.stdin.on('end', () => {
       const events = [
         { ev: 'act', t: 0, slot: 0 },
         { ev: 'delta', text: 'hallo', pos: 0.5 },
         { ev: 'act', t: 1.5, slot: -1 },
         { ev: 'eof' },
       ];
       for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');
     });
     process.stdin.resume();`,
  );

  // 2 s of 16 kHz s16le silence: the audio, without a file to decode.
  const pcm = Buffer.alloc(32000 * 2);
  const silence = () =>
    new Readable({
      read() {
        this.push(pcm);
        this.push(null);
      },
    });

  const seen: import('../src/engine.ts').EngineEvent[] = [];
  let exitCode: number | null = null;
  let settle: (() => void) | undefined;
  const drained = new Promise<void>(res => {
    settle = res;
  });
  const run = new EngineRun(
    {
      command: process.execPath,
      args: [stub],
      readyMarker: 'stub engine ready',
      source: () => ({ stream: silence(), stop: () => {} }),
    },
    { type: 'push', paced: false },
    {
      onEvent: e => {
        seen.push(e);
        if (e.ev === 'eof') settle?.();
      },
      onExit: c => {
        exitCode = c;
      },
    },
    quiet,
  );
  await run.start();
  await drained; // the whole file has passed through the engine and the ring
  const slice = run.slice(0.1, 0.3);
  assert.ok(slice && slice.length === 3200, 'ring holds the fed audio for slicing');
  assert.deepEqual(
    seen.map(e => e.ev),
    ['act', 'delta', 'act', 'eof'],
  );
  assert.ok(run.eof, 'eof event recorded');
  await run.stop();
  assert.equal(exitCode, null, 'no unexpected-exit callback after stop');
});

test('batch wire: float PCM survives the base64 s16le round trip', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const bytes = Buffer.from(samplesToBase64(samples), 'base64');
  assert.equal(bytes.length, samples.length * 2);
  const back = Array.from({ length: samples.length }, (_, i) => bytes.readInt16LE(i * 2) / 32768);
  assert.ok(back.every((v, i) => Math.abs(v - samples[i]!) < 1 / 32768 + 1e-6));
});

test('diarizer slots become people once: middle-half hash, bound first line, no diarizer no name', () => {
  const commits: Array<{ t1: number; speaker: string; text: string }> = [];
  const hashes: Array<[number, number]> = [];
  const fusion = new MixedFusion({
    mode: 'call',
    wakePhrases: [],
    label: 'test',
    log: quiet as never,
    emit: () => {},
    speaking: () => false,
    barge: () => {},
    identify: (t0, t1) => {
      hashes.push([t0, t1]);
      return `p${hashes.length}`; // a new person per hash: the test counts hashes, the store mints names
    },
    commit: (_t0, t1, speaker, text) => void commits.push({ t1, speaker, text }),
  });
  // Before the engine's `diar` answer arrives (or with an engine that never
  // gives one), slots are loudness labels: naming them would invent people.
  fusion.event({ ev: 'act', t: 0, slot: 0 });
  fusion.event({ ev: 'delta', text: 'hallo', pos: 0.5 });
  fusion.event({ ev: 'act', t: 3, slot: -1 });
  assert.equal(commits[0]!.speaker, '', 'no diar answer: the line stays nameless');
  assert.equal(hashes.length, 0, 'speaker-id sleeps until slots are people');
  // The diarizer is loaded: slot numbers are now person candidates.
  fusion.event({ ev: 'diar', on: true });
  fusion.event({ ev: 'act', t: 4, slot: 1 });
  fusion.event({ ev: 'delta', text: 'goedemorgen', pos: 4.5 });
  fusion.event({ ev: 'act', t: 7, slot: -1 });
  assert.deepEqual(hashes[0], [4.75, 6.25], 'only the clean middle half of the stretch is hashed');
  assert.equal(commits[1]!.speaker, 'p1', 'the first line this slot spoke already carries its name');
  // Same slot again: the binding stands, no second voiceprint.
  fusion.event({ ev: 'act', t: 8, slot: 1 });
  fusion.event({ ev: 'delta', text: 'nog wat', pos: 8.5 });
  fusion.event({ ev: 'act', t: 10, slot: 2 });
  assert.equal(commits[2]!.speaker, 'p1');
  assert.equal(hashes.length, 1, 'a slot is voiceprinted once per meeting');
  // A new slot that only clears its throat: under the minimum, no hash —
  // thin samples are exactly what minted fake people.
  fusion.event({ ev: 'delta', text: 'hm', pos: 10.2 });
  fusion.event({ ev: 'act', t: 10.8, slot: -1 });
  assert.equal(commits[3]!.speaker, '', 'under two seconds: no hash, no name');
  assert.equal(hashes.length, 1);
  // The throat-clearer grows into a real turn: that stretch gets hashed,
  // and the lines from slot 2 are named from then on.
  fusion.event({ ev: 'act', t: 12, slot: 2 });
  fusion.event({ ev: 'delta', text: 'nu wel', pos: 12.5 });
  fusion.event({ ev: 'act', t: 15, slot: -1 });
  assert.equal(hashes.length, 2, 'the longest stretch gets its one shot');
  assert.deepEqual(hashes[1], [12.75, 14.25]);
  assert.equal(commits[4]!.speaker, 'p2', 'the bound name rides every later line');
});

test('a wake cut closes the line, not the speaker: the addressed remainder keeps its name', () => {
  const commits: Array<{ speaker: string; text: string; wake: string | null }> = [];
  const fusion = new MixedFusion({
    mode: 'meeting',
    wakePhrases: ['hey assistant'],
    label: 'test',
    log: quiet as never,
    emit: () => {},
    speaking: () => false,
    barge: () => {},
    identify: () => 'Wesley',
    commit: (_t0, _t1, speaker, text, wake) => void commits.push({ speaker, text, wake }),
  });
  fusion.event({ ev: 'diar', on: true });
  fusion.event({ ev: 'act', t: 0, slot: 1 });
  fusion.event({ ev: 'delta', text: 'eerst iets', pos: 1 });
  fusion.event({ ev: 'act', t: 3, slot: -1 });
  assert.equal(commits[0]!.speaker, 'Wesley', 'the slot was voiceprinted at its first close');
  fusion.event({ ev: 'act', t: 4, slot: 1 });
  fusion.event({ ev: 'delta', text: 'hey assistant, ', pos: 4.5 });
  assert.equal(commits[1]!.wake, 'hey assistant', 'the addressed sentence is cut where it was said');
  assert.equal(commits[1]!.speaker, 'Wesley', 'the addressed line carries the speaker, not a stranger');
  fusion.event({ ev: 'delta', text: 'wat denk je?', pos: 5 });
  fusion.event({ ev: 'act', t: 6, slot: -1 });
  assert.equal(commits[2]!.wake, null, 'the remainder is a line of its own, no second wake');
  assert.equal(commits[2]!.speaker, 'Wesley', 'the wake cut did not orphan the rest of his utterance');
});

test('batch engine: serialized requests, error lines and death resolve, never hang', async () => {
  const stub = join(tmpdir(), `voice-batch-stub-${process.pid}.cjs`);
  writeFileSync(
    stub,
    `process.stderr.write('engine ready (batch)\\n');
     require('readline').createInterface({ input: process.stdin }).on('line', l => {
       const r = JSON.parse(l);
       process.stdout.write(JSON.stringify(r.id === 'r1' ? { id: r.id, text: 'hallo' } : { id: r.id, error: 'boom' }) + '\\n');
     });`,
  );
  const run = new BatchEngineRun({ command: process.execPath, args: [stub], readyMarker: 'engine ready' }, quiet, 5000);
  try {
    await run.start();
    assert.equal(await run.transcribe(new Float32Array(16000)), 'hallo');
    assert.equal(await run.transcribe(new Float32Array(16000)), null); // error line -> lost, logged
    await run.stop();
    assert.equal(await run.transcribe(new Float32Array(16000)), null); // dead engine answers null
  } finally {
    await run.stop(); // a failed assertion must never leak the engine child
    rmSync(stub, { force: true });
  }
});

test('engine push: written frames reach the engine and the ring', async () => {
  const stub = join(tmpdir(), `voice-push-stub-${process.pid}.cjs`);
  writeFileSync(stub, "process.stderr.write('engine ready\\n'); process.stdin.resume();");
  try {
    const run = new EngineRun(
      { command: process.execPath, args: [stub], readyMarker: 'engine ready' },
      { type: 'push' },
      { onEvent() {}, onExit() {} },
      quiet,
    );
    await run.start();
    run.write(Buffer.alloc(3200, 7)); // 0.1 s of s16le
    const slice = run.slice(0, 0.1);
    assert.ok(slice && slice.length === 1600, 'pushed audio lands in the ring');
    await run.stop();
  } finally {
    rmSync(stub, { force: true });
  }
});

// The protocol the engine actually speaks: JSONL in, both directions. This
// stub echoes the batch answer and proves the audio frame arrived as JSON.
test('engine protocol: JSONL audio frames in, batch transcribe answers on the same line', async () => {
  const stub = join(tmpdir(), `voice-proto-stub-${process.pid}.cjs`);
  writeFileSync(
    stub,
    `let buf='';
     process.stderr.write('engine ready\\n');
     process.stdin.setEncoding('utf8');
     process.stdin.on('data', d => {
       buf += d;
       for(;;){ const i=buf.indexOf('\\n'); if(i<0)break;
         const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim())continue;
         const m=JSON.parse(line);
         if(m.id){
           // a batch request: audio arrived base64 s16le; echo its length back
           const bytes=Buffer.from(m.a,'base64').length;
           process.stdout.write(JSON.stringify({id:m.id,text:'heard '+bytes+' bytes'})+'\\n');
         } else {
           // a streaming frame: prove it is JSON with an 'a', answer once
           if(m.a) process.stdout.write(JSON.stringify({ev:'delta',text:'ok',pos:0})+'\\n');
         }
       }
     });`,
  );
  try {
    const events: Array<Record<string, unknown>> = [];
    const run = new EngineRun(
      { command: process.execPath, args: [stub], readyMarker: 'engine ready', model: 'x/Voxtral' },
      { type: 'push' },
      { onEvent: e => events.push(e as unknown as Record<string, unknown>), onExit() {} },
      quiet,
    );
    await run.start();
    run.write(Buffer.alloc(3200, 7)); // a streaming frame → the stub emits one delta
    const text = await run.transcribe(new Float32Array(1600).fill(0.1)); // 0.1 s → 3200 bytes s16le
    assert.equal(text, 'heard 3200 bytes', 'the batch answer came back on the request id');
    assert.ok(
      events.some(e => e.ev === 'delta'),
      'streaming deltas still flow',
    );
    await run.stop();
  } finally {
    rmSync(stub, { force: true });
  }
});

test('a dead engine answers pending batch requests with null, never a hang', async () => {
  const stub = join(tmpdir(), `voice-die-stub-${process.pid}.cjs`);
  writeFileSync(stub, "process.stderr.write('engine ready\\n'); process.stdin.on('data', () => process.exit(3));");
  try {
    const run = new EngineRun(
      { command: process.execPath, args: [stub], readyMarker: 'engine ready' },
      { type: 'push' },
      { onEvent() {}, onExit() {} },
      quiet,
    );
    await run.start();
    const text = await run.transcribe(new Float32Array(800)); // the write kills the stub
    assert.equal(text, null, 'a request into a dying engine resolves, it does not hang');
    await run.stop();
  } finally {
    rmSync(stub, { force: true });
  }
});

// Real sockets on loopback, so this test carries its own timeout: V8-coverage
// processing on a loaded machine can stall the event loop past the suite's
// default. Every server frame is one JSON event — the open handshake is the
// hello, and the reply wav rides inside its event (two frames can share one
// TCP segment and a listener attached between them loses the second; the
// suite caught this, so the protocol cannot).
test('tts run: chunks land as they are spoken; errors and death answer nothing', async () => {
  const stub = join(tmpdir(), `voice-tts-stub-${process.pid}.cjs`);
  writeFileSync(
    stub,
    `process.stderr.write('tts ready (voxtral-tts loaded)\\n');
     require('readline').createInterface({ input: process.stdin }).on('line', l => {
       const r = JSON.parse(l);
       if (r.text.includes('boom')) {
         process.stdout.write(JSON.stringify({ id: r.id, error: 'no voice' }) + '\\n');
         return;
       }
       if (r.stream) {
         // Speak while synthesizing: two chunks, the last one final.
         process.stdout.write(JSON.stringify({ id: r.id, seq: 0, audio: Buffer.from('chunk-one').toString('base64'), sr: 24000, final: false }) + '\\n');
         process.stdout.write(JSON.stringify({ id: r.id, seq: 1, audio: Buffer.from('chunk-two').toString('base64'), sr: 24000, final: true }) + '\\n');
         return;
       }
       process.stdout.write(JSON.stringify({ id: r.id, seq: 0, audio: Buffer.from('wavsounds').toString('base64'), sr: 24000 }) + '\\n');
     });`,
  );
  const say = async (g: AsyncGenerator<Buffer>): Promise<string[]> => {
    const out: string[] = [];
    for await (const wav of g) out.push(wav.toString());
    return out;
  };
  const run = new TtsRun(
    { command: process.execPath, args: [stub], readyMarker: 'tts ready', voice: 'nl_female', stream: true },
    quiet,
    5000,
  );
  try {
    await run.start();
    assert.deepEqual(
      await say(run.chunks('hallo')),
      ['chunk-one', 'chunk-two'],
      'chunks land in order, the final one closes',
    );
    assert.deepEqual(await say(run.chunks('dit boomt')), [], 'engine error: the sentence goes unspoken');
    // Barge-in mid-sentence: the abandoned stream's rest goes unheard and
    // the next sentence still gets its turn.
    const g = run.chunks('hallo');
    assert.equal((await g.next()).value?.toString(), 'chunk-one');
    await g.return(undefined);
    assert.deepEqual(
      await say(run.chunks('hallo')),
      ['chunk-one', 'chunk-two'],
      'abandoning did not hold the model hostage',
    );
    await run.stop();
    assert.deepEqual(await say(run.chunks('na stop')), [], 'a silent aivi is a logged aivi');
  } finally {
    await run.stop();
    rmSync(stub, { force: true });
  }
});

test('tts run: stream off is the same protocol with one final chunk', async () => {
  const stub = join(tmpdir(), `voice-tts-flat-${process.pid}.cjs`);
  writeFileSync(
    stub,
    `process.stderr.write('tts ready (voxtral-tts loaded)\\n');
     require('readline').createInterface({ input: process.stdin }).on('line', l => {
       const r = JSON.parse(l);
       process.stdout.write(JSON.stringify({ id: r.id, seq: 0, audio: Buffer.from('wavsounds').toString('base64'), sr: 24000 }) + '\\n');
     });`,
  );
  const run = new TtsRun(
    { command: process.execPath, args: [stub], readyMarker: 'tts ready', voice: 'nl_female', stream: false },
    quiet,
    5000,
  );
  try {
    await run.start();
    const heard: string[] = [];
    for await (const wav of run.chunks('hallo')) heard.push(wav.toString());
    assert.deepEqual(heard, ['wavsounds'], 'the finished sentence is its own final chunk');
  } finally {
    await run.stop();
    rmSync(stub, { force: true });
  }
});

test('transcripts group lines and pages walk back through one group', () => {
  const store = new VoiceStore(new Store(':memory:') as never, quiet);
  const mon = store.openTranscript('monday.wav');
  const tue = store.openTranscript('tuesday.wav');
  for (let i = 1; i <= 7; i++) store.appendLine(mon, i, i + 1, 't1', `line ${i}`);
  store.appendLine(tue, 0, 1, 't2', 'apart');

  const groups = store.transcripts();
  assert.deepEqual(
    groups.map(g => [g.source, g.lines]),
    [
      ['tuesday.wav', 1],
      ['monday.wav', 7],
    ],
  );

  const page1 = store.readLines({ transcript: mon, last: 3 });
  assert.deepEqual(
    page1.map(l => l.text),
    ['line 5', 'line 6', 'line 7'],
  );
  const page2 = store.readLines({ transcript: mon, last: 3, before: page1[0]!.id });
  assert.deepEqual(
    page2.map(l => l.text),
    ['line 2', 'line 3', 'line 4'],
  );
  assert.deepEqual(
    store.readLines({ transcript: mon, last: 3, before: page2[0]!.id }).map(l => l.text),
    ['line 1'],
  );
});

// The capacity seam: voice turns take dispatcher slots exactly like ticket
// work — request, provide (the pool decides the model at session create),
// work, release; a full pool queues and the callback hands the slot over.
class FakeDispatcher {
  static minted = 0;
  held = 0;
  seq = 0;
  queue: Array<{ id: string; service: string; pool: string; resume?: string }> = [];
  private cb: ((requestId: string, lease: Record<string, unknown>) => void) | null = null;
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  registerCallback(_service: string, cb: (requestId: string, lease: never) => void): void {
    this.cb = cb as (requestId: string, lease: Record<string, unknown>) => void;
  }
  request(input: {
    service: string;
    pool?: string;
    resume?: string;
  }): { lease: Record<string, unknown> } | { queued: string } | { refused: string; pool: string } {
    const pool = input.pool ?? 'default';
    if (this.held < this.capacity) {
      this.held++;
      const id = `le_${++this.seq}`;
      return { lease: { id, pool, state: input.resume ? 'active' : 'preparing' } };
    }
    if (this.queue.some(w => w.service === input.service)) return { refused: 'waiting', pool };
    const id = `req_${++this.seq}`;
    this.queue.push({ id, service: input.service, pool, ...(input.resume ? { resume: input.resume } : {}) });
    return { queued: id };
  }
  async provide(leaseId: string, work: { agent: string; directory: string; sessionId?: string }) {
    // global counter: two harnesses never mint the same id, so a resume that
    // silently did NOT happen cannot hide behind an identical string
    const sessionId = work.sessionId ?? `ses_${work.agent}_x${++this.seq}_${++FakeDispatcher.minted}`;
    return { id: leaseId, pool: 'default', state: 'active', sessionId };
  }
  async release(leaseId: string) {
    this.held--;
    const next = this.held < this.capacity ? this.queue.shift() : undefined;
    if (next) {
      this.held++;
      this.cb?.(next.id, { id: `le_${++this.seq}`, pool: next.pool, state: next.resume ? 'active' : 'preparing' });
    }
    return { ended: { id: leaseId, pool: 'default', state: 'active' } };
  }
  cancel(requestId: string): void {
    this.queue = this.queue.filter(w => w.id !== requestId);
  }
}

function turnsHarness(capacity: number, steerWhenBusy = false) {
  const dispatcher = new FakeDispatcher(capacity);
  const seats = new Map<string, VoiceTurns>();
  const calls: Array<{ input: Record<string, unknown>; heldDuring: number }> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  let gate: () => void = () => {};
  const busy = new Promise<void>(res => {
    gate = res;
  });
  let moved = 0;
  const turns = new VoiceTurns(
    { pool: 'voice-test', agent: 'assistant', directory: '.', steerWhenBusy, origin: 'test', transcript: 1 },
    {
      dispatcher: dispatcher as never,
      opencode: async () =>
        ({ session: { prompt: async (p: Record<string, unknown>) => void promptCalls.push(p) } }) as never,
      runTurn: (async (_c: never, input: Record<string, unknown>) => {
        calls.push({ input, heldDuring: dispatcher.held });
        await busy;
        return { text: 'antwoord' };
      }) as never,
      session: () => undefined,
      rememberSession: () => {},
      clearSession: () => {},
      rememberLease: () => {},
      requestSeat: (id, t) => seats.set(id, t),
      releaseSeat: id => {
        seats.delete(id);
      },
      capacityMoved: () => moved++,
      servicesSignal: new AbortController().signal,
      events: noEvents,
      log: quiet as never,
    },
  );
  // the module's routing, mirrored: the callback fulfils the seat it belongs to
  dispatcher.registerCallback('voice', (requestId: string, lease: never) => {
    const t = seats.get(requestId);
    seats.delete(requestId);
    if (t) t.fulfill(lease as never);
  });
  const tick = () => new Promise(res => setImmediate(res));
  return { dispatcher, turns, calls, promptCalls, seats, gate, moved: () => moved, tick };
}

test('a voice turn takes its slot, gets a session from the pool, and returns the slot', async () => {
  const h = turnsHarness(1);
  h.turns.prompt({ text: 'hallo', speakers: ['t1'] });
  await h.tick();
  assert.equal(h.calls.length, 1, 'the prompt ran');
  assert.equal(h.calls[0]!.heldDuring, 1, 'the pool slot was held while the model worked');
  assert.equal(h.calls[0]!.input.create, false, 'the lease provide created the session, not the prompt');
  assert.match(String(h.calls[0]!.input.sessionId), /^ses_assistant_x/, 'the session id is the dispatcher-minted one');
  h.gate();
  await h.tick();
  await h.tick();
  assert.equal(h.dispatcher.held, 0, 'the slot came back');
  assert.ok(h.moved() >= 1, 'the fan-out told the module capacity moved');
});

test('a full pool queues, does not drop: the callback hands the slot to the waiting line', async () => {
  const h = turnsHarness(1);
  const outside = h.dispatcher.request({ service: 'orchestrator' }) as { lease: { id: string } };
  assert.ok(outside.lease, 'somebody else holds the only slot');
  h.turns.prompt({ text: 'later', speakers: ['t1'] });
  await h.tick();
  assert.equal(h.calls.length, 0, 'no slot, no run — and no lost prompt');
  assert.equal(h.dispatcher.queue.length, 1, 'the dispatcher took the queue place');
  const { ended } = await h.dispatcher.release(outside.lease.id); // capacity frees elsewhere
  void ended;
  await h.tick();
  assert.equal(h.calls.length, 1, 'the queued prompt ran when the callback landed');
  assert.equal(h.dispatcher.held, 1, 'and it holds the slot now');
  h.gate();
  await h.tick();
  await h.tick();
});

test('a call room steers the running turn instead of taking a second slot', async () => {
  const h = turnsHarness(2, true);
  h.turns.prompt({ text: 'werk', speakers: ['t1'] });
  await h.tick();
  h.turns.prompt({ text: 'links', speakers: ['t2'] }); // mid-turn: this steers
  await h.tick(); // the steer goes out on the next tick
  assert.equal(h.promptCalls.length, 1, 'the line went in as a steer');
  assert.equal(h.promptCalls[0]!.delivery, 'steer');
  assert.equal(
    h.promptCalls[0]!.text,
    'links',
    'the person\u2019s own words, undecorated: the steer delivery is OpenCode\u2019s, the speaker is metadata',
  );
  assert.equal(h.dispatcher.held, 1, 'steering borrows no second slot');
  h.gate();
  await h.tick();
  await h.turns.stop();
});

// Engine warmth is the module's job (ruled 2026-10-12): a meeting leaving
// must not reload models. The shared engine is born at the host's first
// audio, survives every room, and dies only when the module stops.
test('shared engine: born at first audio, warm across rooms, ended by the module', async () => {
  const stub = join(tmpdir(), `voice-shared-stub-${process.pid}.cjs`);
  const spawns = join(tmpdir(), `voice-shared-spawns-${process.pid}.txt`);
  rmSync(spawns, { force: true });
  writeFileSync(
    stub,
    `require('node:fs').appendFileSync(${JSON.stringify(spawns)}, 'spawn\\n');
     let buf='';
     process.stderr.write('engine ready\\n');
     process.stdin.setEncoding('utf8');
     process.stdin.on('data', d => {
       buf += d;
       for(;;){ const i=buf.indexOf('\\n'); if(i<0)break;
         const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim())continue;
         const m=JSON.parse(line);
         if(m.id) process.stdout.write(JSON.stringify({id:m.id,text:'hallo'})+'\\n');
       }
     });`,
  );
  try {
    const shared = new SharedEngine({ command: process.execPath, args: [stub], readyMarker: 'engine ready' }, quiet);
    const statesA: string[] = [];
    const sinkA = { onEvent() {}, onState: (s: string) => void statesA.push(s) };
    shared.attach(sinkA);
    assert.deepEqual(statesA, ['idle'], 'a room sees the current state at once');

    shared.push(Buffer.alloc(3200, 7)); // the host's first audio: the engine is born
    const run = await shared.ready();
    assert.ok(run, 'the engine loaded for the first audio');
    assert.equal(statesA.at(-1), 'ready');
    assert.equal(await run.transcribe(new Float32Array(1600).fill(0.1)), 'hallo');

    // a second meeting opens on a warm host: it sees ready, no reload
    const statesB: string[] = [];
    const sinkB = { onEvent() {}, onState: (s: string) => void statesB.push(s) };
    shared.attach(sinkB);
    assert.deepEqual(statesB, ['ready'], 'a later room starts warm');

    // the first room walks out: the models stay loaded for the next one
    shared.detach(sinkA);
    assert.equal(await shared.ready(), run, 'the same engine, still warm');
    assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 1, 'two rooms, one spawn');

    await shared.stop(); // only the module ends the engine
    assert.equal(statesB.at(-1), 'idle', 'rooms hear the engine go quiet');
    assert.equal(await shared.ready(), null, 'a stopped module never reloads');
  } finally {
    rmSync(stub, { force: true });
    rmSync(spawns, { force: true });
  }
});

test('a crashed shared engine is not cached: the next audio loads a fresh one', async () => {
  const stub = join(tmpdir(), `voice-recrude-stub-${process.pid}.cjs`);
  const spawns = join(tmpdir(), `voice-recrude-spawns-${process.pid}.txt`);
  rmSync(spawns, { force: true });
  writeFileSync(
    stub,
    `require('node:fs').appendFileSync(${JSON.stringify(spawns)}, 'spawn\\n');
     process.stderr.write('engine ready\\n');
     process.stdin.on('data', () => process.exit(3));`,
  );
  try {
    const shared = new SharedEngine({ command: process.execPath, args: [stub], readyMarker: 'engine ready' }, quiet);
    let markFailed = () => {};
    const failed = new Promise<void>(resolve => {
      markFailed = resolve;
    });
    shared.attach({ onEvent() {}, onState: s => void (s === 'failed' && markFailed()) });
    shared.push(Buffer.alloc(3200, 7));
    assert.ok(await shared.ready(), 'the first load succeeded before dying');
    await failed; // the engine died mid-room: state says so, loudly
    shared.push(Buffer.alloc(3200, 7)); // the dead engine must be replaced, not reused
    const second = await shared.ready();
    assert.ok(second, 'the next audio tried the load again');
    assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 2, 'a dead engine is replaced, not reused');
    await shared.stop();
  } finally {
    rmSync(stub, { force: true });
    rmSync(spawns, { force: true });
  }
});

// The room's session id outlived OpenCode's storage (a restart, retention):
// every prompt used to resume the dead id and fail forever. One strike now,
// then a fresh session.
test('a persisted session that died with an old OpenCode is replaced, not retried forever', async () => {
  const dispatcher = new FakeDispatcher(1);
  const seats = new Map<string, VoiceTurns>();
  const inputs: Array<Record<string, unknown>> = [];
  let sessionId: string | undefined = 'ses_voice_stale0001';
  const logs: string[] = [];
  const log = {
    info: (m: string) => void logs.push(m),
    warn: (m: string) => void logs.push(m),
    error: (m: string) => void logs.push(m),
  };
  const turns = new VoiceTurns(
    { pool: 'voice-test', agent: 'assistant', directory: '.', steerWhenBusy: false, origin: 'test', transcript: 1 },
    {
      dispatcher: dispatcher as never,
      opencode: async () => ({}) as never,
      runTurn: (async (_c: never, input: Record<string, unknown>) => {
        inputs.push(input);
        if (input.sessionId === 'ses_voice_stale0001') throw new Error('Session not found: ses_voice_stale0001');
        return { text: 'hier ben ik' };
      }) as never,
      session: () => sessionId,
      rememberSession: id => {
        sessionId = id;
      },
      clearSession: () => {
        sessionId = undefined;
      },
      rememberLease: () => {},
      requestSeat: (id, t) => seats.set(id, t),
      releaseSeat: id => {
        seats.delete(id);
      },
      capacityMoved: () => {},
      servicesSignal: new AbortController().signal,
      events: noEvents,
      log: log as never,
    },
  );
  dispatcher.registerCallback('voice', (requestId: string, lease: never) => {
    const t = seats.get(requestId);
    seats.delete(requestId);
    if (t) t.fulfill(lease as never);
  });
  turns.prompt({ text: 'Hallo?', speakers: ['t1'] });
  for (let i = 0; i < 8; i++) await new Promise(res => setImmediate(res));
  assert.ok(logs.includes('turns.session.stale'), 'the dead session is named once');
  assert.ok(!logs.includes('turns.failed'), 'a replace is not a failure: no spam');
  assert.equal(inputs.length, 2, 'the line went out again, not lost');
  assert.notEqual(inputs[1]!.sessionId, 'ses_voice_stale0001', 'the retry rode a fresh session');
  assert.equal(dispatcher.held, 0, 'and the slot came back');
  await turns.stop();
});

// The conversation itself: a call room keeps no record, batches finished
// speech into one prompt, and can be interrupted mid-answer.

/** A whole room with all its machinery and nothing alive: fake engine and
 *  dispatcher, real sqlite store. Tests speak through `heard` (the Discord
 *  shape: named, finished utterances) and listen through `mouth`. Pass a
 *  store and db to share them across rooms — that is how a rejoin is faked. */
function roomHarness(
  mode: 'call' | 'meeting',
  opts: {
    texts?: string[];
    ttsGate?: () => Promise<void>;
    store?: VoiceStore;
    db?: Store;
    resumeMinutes?: number | false;
    /** The answer's text streamed DURING the turn, one array entry per
     *  `session.text.delta` — drives the sentence-by-sentence speech lane. */
    stream?: string[];
    /** The final answer text the fake turn returns (default 'antwoord'). */
    answer?: string;
    /** The sentence's speech as separate TTS chunks (wav bodies): the first
     *  lands at once, the rest wait behind the chunkGate. */
    ttsChunks?: string[];
    chunkGate?: () => Promise<void>;
    /** No engine at all: lanes fall back to batch transcription (or are lost). */
    engineNull?: boolean;
    /** The engine never answers a lane flush (dying engine). */
    noLaneEnd?: boolean;
    /** Text a configured `stt` endpoint answers with. */
    stt?: string;
  } = {},
) {
  const dispatcher = new FakeDispatcher(1);
  const seats = new Map<string, VoiceTurns>();
  const calls: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const log = {
    debug: (msg: string) => void logs.push(msg),
    info: (msg: string) => void logs.push(msg),
    warn: (msg: string) => void logs.push(msg),
    error: (msg: string) => void logs.push(msg),
  };
  const db = opts.db ?? new Store(':memory:');
  const store = opts.store ?? new VoiceStore(db as never, quiet);
  const texts = [...(opts.texts ?? [])];
  // The shared engine as the rooms see it: attached sinks see every event,
  // and a lane is a real call — writeLane feeds live audio, endLane flushes
  // and answers lane_end ASYNC, like the child process would.
  const sinks: Array<{ onEvent(e: unknown): void; onState(s: string): void }> = [];
  const laneCalls: string[] = [];
  const engineRun = opts.engineNull
    ? null
    : {
        transcribe: async () => texts.shift() ?? null,
        writeLane: (id: string, _pcm: Float32Array) => {
          if (!laneCalls.includes(`w:${id}`)) laneCalls.push(`w:${id}`);
        },
        endLane: (id: string) => {
          laneCalls.push(`e:${id}`);
          if (opts.noLaneEnd) return; // a dying engine: the flush never answers
          setTimeout(() => {
            for (const s of sinks) s.onEvent({ ev: 'lane_end', lane: id });
          }, 0);
        },
      };
  const sharedEngine = {
    attach(sink: (typeof sinks)[number]) {
      sinks.push(sink);
      sink.onState(engineRun ? 'ready' : 'idle');
    },
    detach(sink: (typeof sinks)[number]) {
      const i = sinks.indexOf(sink);
      if (i >= 0) sinks.splice(i, 1);
    },
    push() {},
    ready: async () => engineRun,
    slice: () => null,
    stop: async () => {},
  };
  const emitLane = (e: Record<string, unknown>) => {
    for (const s of [...sinks]) s.onEvent(e);
  };
  const emitLaneState = (state: string) => {
    for (const s of [...sinks]) s.onState(state);
  };
  // Every sentence that reached the voice, in order — the proof that the
  // answer was spoken as it streamed, not as one whole block.
  const ttsTexts: string[] = [];
  // The event bus: the fake turn streams answer text through it while running.
  const watchers = new Set<(e: { type: string; data?: Record<string, unknown> }) => void>();
  const events = {
    watch: (_id: string, fn: (e: { type: string; data?: Record<string, unknown> }) => void) => {
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
  };
  const emitText = (type: 'session.text.started' | 'session.text.delta', delta?: string) => {
    for (const fn of [...watchers])
      fn(delta ? { type, data: { assistantMessageID: 'm1', delta } } : { type, data: { assistantMessageID: 'm1' } });
  };
  const room = new HearingRoom(
    { id: 'test', label: `${mode}:test`, streaming: false, engineInput: { type: 'push' } },
    {
      mode,
      wakePhrases: [],
      engineSpec: { command: 'true', args: [], readyMarker: 'ready' },
      agent: 'assistant',
      directory: '.',
      model: undefined,
      pool: 'voice-test',
      identity: undefined,
      embedder: null,
      store,
      sharedEngine: sharedEngine as never,
      getStt: async () => (opts.stt ? { transcribe: async () => opts.stt! } : null),
      getTts: async () =>
        ({
          chunks: async function* (text: string) {
            ttsTexts.push(text);
            if (opts.ttsGate) await opts.ttsGate();
            if (opts.ttsChunks) {
              yield Buffer.from(opts.ttsChunks[0]!);
              if (opts.ttsChunks.length > 1) {
                if (opts.chunkGate) await opts.chunkGate();
                for (const c of opts.ttsChunks.slice(1)) yield Buffer.from(c);
              }
              return;
            }
            yield Buffer.from('RIFFfakewav');
          },
        }) as never,
      finishWindowMs: 50,
      resumeMinutes: opts.resumeMinutes ?? 30,
      dispatcher: dispatcher as never,
      opencode: async () => ({ session: { prompt: async () => {} } }) as never,
      runTurn: (async (_c: never, input: Record<string, unknown>) => {
        calls.push(input);
        if (opts.stream) {
          emitText('session.text.started');
          for (const d of opts.stream) emitText('session.text.delta', d);
        }
        return { text: opts.answer ?? 'antwoord' };
      }) as never,
      requestSeat: (id: string, t: VoiceTurns) => seats.set(id, t),
      releaseSeat: (id: string) => {
        seats.delete(id);
      },
      capacityMoved: () => {},
      servicesSignal: new AbortController().signal,
      events: events as never,
      log: log as never,
    },
  );
  dispatcher.registerCallback('voice', (requestId: string, lease: never) => {
    const t = seats.get(requestId);
    seats.delete(requestId);
    if (t) t.fulfill(lease as never);
  });
  // longer than the finished window (50 ms): the person is done by then
  const settle = () => new Promise(res => setTimeout(res, 150));
  return { room, store, db, calls, logs, ttsTexts, emitText, emitLane, emitLaneState, laneCalls, settle };
}

const pcm = new Float32Array(1600);

test('call room: no record anywhere; finished speech is one prompt', async () => {
  const h = roomHarness('call', { texts: ['the wire is', 'alive again'] });
  assert.equal(await h.room.heard({ speaker: 'Wesley', user: 'u1', channel: 'c1', pcm }), 'the wire is');
  assert.equal(await h.room.heard({ speaker: 't1', pcm }), 'alive again');
  assert.equal(h.calls.length, 0, 'not finished speaking yet: the session has heard nothing');
  assert.equal(h.store.transcripts().length, 0, 'a call room keeps no record');
  await h.settle();
  assert.equal(h.calls.length, 1, 'one prompt for one finished turn of speech');
  const call = h.calls[0]!;
  assert.match(String(call.text), /the wire is alive again|\[t1\] alive again/);
  const aivi = (call.messageMetadata as { aivi: Record<string, unknown> }).aivi;
  assert.equal('transcript' in aivi, false, 'no transcript pointer: there is nothing to point at');
  assert.deepEqual(aivi.speakers, ['Wesley', 't1'], 'every voice in the finished batch, in order of arrival');
  await h.room.stop();
});

test('barge-in: a word during synthesis kills the answer before it speaks', async () => {
  let openTts = () => {};
  const h = roomHarness('call', {
    texts: ['hello?'],
    ttsGate: () =>
      new Promise<void>(res => {
        openTts = res;
      }),
  });
  const played: Buffer[] = [];
  let stops = 0;
  const events: Array<Record<string, unknown>> = [];
  h.room.mouth(
    wav => {
      played.push(wav);
      return true;
    },
    () => {
      stops++;
    },
  );
  h.room.onEvent(e => events.push(e));
  await h.room.heard({ speaker: 'Wesley', pcm });
  await h.settle(); // flush → turn → answer → voice still synthesizing
  assert.equal(played.length, 0, 'the voice is still being synthesized');
  h.room.bargeIn();
  assert.equal(stops, 1, 'the mouth is silenced at once');
  assert.ok(
    events.some(e => e.ev === 'stop_audio'),
    'the room is told to fall silent',
  );
  openTts();
  await h.settle();
  assert.equal(played.length, 0, 'the answer died mid-synthesis: the person spoke first');
  assert.ok(h.logs.includes('voice.reply.interrupted'), h.logs.join('\n'));
  await h.room.stop();
});

test('meeting room: the record stays and barge-in stays polite', async () => {
  const h = roomHarness('meeting', { texts: ['quarterly numbers'] });
  let stops = 0;
  h.room.mouth(
    () => true,
    () => {
      stops++;
    },
  );
  assert.equal(await h.room.heard({ speaker: 't1', pcm }), 'quarterly numbers');
  const groups = h.store.transcripts();
  assert.equal(groups.length, 1, 'a meeting keeps its record');
  assert.equal(groups[0]!.lines, 1);
  assert.equal(h.calls.length, 0, 'no wake phrase: the meeting is not addressed');
  h.room.bargeIn();
  assert.equal(stops, 0, 'meetings are polite: barge-in does nothing there');
  await h.room.stop();
});

// The resume window: a rejoin within the quiet gap continues the session;
// past it, the room starts fresh — an old conversation is prefill, not free.

test('room sessions: resume inside the window, fresh past it', async () => {
  const db = new Store(':memory:');
  const h1 = roomHarness('call', { texts: ['still here?'], db });
  await h1.room.heard({ speaker: 'Wesley', pcm });
  await h1.settle();
  const first = h1.calls[0]!.sessionId as string;
  assert.ok(first, 'the pool minted a session');
  assert.equal(h1.store.roomSession('call:test'), first, 'and the room remembers which one');
  await h1.room.stop();

  // rejoin right away: the conversation continues
  const h2 = roomHarness('call', { texts: ['back again'], db, store: h1.store });
  await h2.room.heard({ speaker: 'Wesley', pcm });
  await h2.settle();
  assert.equal(h2.calls[0]!.sessionId, first, 'a rejoin within the window resumes the session');
  assert.ok(!h2.logs.includes('voice.session.expired'), h2.logs.join('\n'));
  await h2.room.stop();

  // thirty-one quiet minutes later: fresh, and the log says why
  db.db
    .prepare("UPDATE voice_state SET value = ? WHERE key = 'session_at:call:test'")
    .run(String(Date.now() - 31 * 60_000));
  const h3 = roomHarness('call', { texts: ['a new day'], db, store: h1.store });
  await h3.room.heard({ speaker: 'Wesley', pcm });
  await h3.settle();
  assert.notEqual(h3.calls[0]!.sessionId, first, 'past the window: a fresh session');
  assert.ok(h3.logs.includes('voice.session.expired'), h3.logs.join('\n'));
  await h3.room.stop();
});

test('resumeMinutes 0: fresh session every join, steady within one', async () => {
  const db = new Store(':memory:');
  const store = new VoiceStore(db as never, quiet);
  store.setRoomSession('call:test', 'ses_old_sitting');
  const h = roomHarness('call', { texts: ['hello?', 'and again'], db, store, resumeMinutes: 0 });
  assert.ok(h.logs.includes('voice.session.expired'), 'the remembered session was another sitting: gone at open');
  await h.room.heard({ speaker: 'Wesley', pcm });
  await h.settle();
  const fresh = h.calls[0]!.sessionId as string;
  assert.notEqual(fresh, 'ses_old_sitting');
  await h.room.heard({ speaker: 'Wesley', pcm });
  await h.settle();
  assert.equal(h.calls[1]!.sessionId, fresh, '0 never expires the room mid-meeting: same session, second sentence');
  await h.room.stop();
});

test('resumeMinutes false: the same session forever, however long the quiet', async () => {
  const db = new Store(':memory:');
  const store = new VoiceStore(db as never, quiet);
  store.setRoomSession('call:test', 'ses_one_forever');
  db.db
    .prepare("UPDATE voice_state SET value = ? WHERE key = 'session_at:call:test'")
    .run(String(Date.now() - 10 * 86_400_000));
  const h = roomHarness('call', { texts: ['still the same?'], db, store, resumeMinutes: false });
  await h.room.heard({ speaker: 'Wesley', pcm });
  await h.settle();
  assert.equal(h.calls[0]!.sessionId, 'ses_one_forever', 'ten days quiet: resumed, the old behavior on purpose');
  assert.ok(!h.logs.includes('voice.session.expired'), h.logs.join('\n'));
  await h.room.stop();
});

test('the resume window restarts on every exchange', () => {
  const db = new Store(':memory:');
  const store = new VoiceStore(db as never, quiet);
  store.touchRoomSession('roomA');
  assert.equal(store.roomSessionAt('roomA'), undefined, 'a touch with no session is nothing, not a stray row');
  store.setRoomSession('roomA', 'ses_a');
  assert.ok(Date.now() - store.roomSessionAt('roomA')!.at < 5_000, 'remembering a session stamps the time');
  db.db
    .prepare("UPDATE voice_state SET value = ? WHERE key = 'session_at:roomA'")
    .run(String(Date.now() - 20 * 60_000));
  store.touchRoomSession('roomA');
  assert.ok(Date.now() - store.roomSessionAt('roomA')!.at < 5_000, 'words went in: the window restarts');
  store.clearRoomSession('roomA');
  assert.equal(store.roomSessionAt('roomA'), undefined, 'clearing takes the timestamp with it');
});

// Speaking the answer AS it is written, and barge-in that waits for a WORD.

test('the first clause speaks at once and the rest coalesces behind the wire', async () => {
  const h = roomHarness('call', {
    texts: ['hoe is het?'],
    stream: ['Alpha. Beta. ', 'Gamma.'],
    answer: 'Alpha. Beta. Gamma.',
  });
  h.room.mouth(() => true);
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle();
  // The wire is ONE voice at a time: the first clause goes to the voice the
  // moment it completes (first sound, no waiting for a whole sentence); while
  // that speaks, every later clause waits and leaves as ONE request — the
  // voice gets long natural text instead of sentence confetti.
  assert.deepEqual(h.ttsTexts, ['Alpha.', 'Beta. Gamma.'], 'first clause at once, the rest as one chunk');
  await h.room.stop();
});

test('a line break in the answer cuts once: nothing repeats, nothing waits', async () => {
  const h = roomHarness('call', {
    texts: ['vraag'],
    // markdown as the assistant writes it: a line ending in a newline, then
    // more. The newline branch once spoke its line on EVERY later delta (the
    // operator heard one sentence five times) and blocked the scan, so the
    // rest left as one long block the TTS mangled into skips and loops.
    stream: ['Kort en krachtig, zoals afgesproken\n\n', 'De tweede zin. En nog een deel.'],
    answer: 'Kort en krachtig, zoals afgesproken\n\nDe tweede zin. En nog een deel.',
  });
  h.room.mouth(() => true);
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle();
  // First clause (the comma) at once; everything after waits and leaves as
  // one chunk — the line break cut ONCE (the old bug re-spoke it on every
  // delta) and the rest was never stranded as one un-cut block.
  assert.deepEqual(
    h.ttsTexts,
    ['Kort en krachtig,', 'zoals afgesproken De tweede zin. En nog een deel.'],
    'each clause reaches the voice exactly once: first alone, the rest coalesced',
  );
  await h.room.stop();
});

test('the answer tail with no closing punctuation is spoken when the answer ends', async () => {
  const h = roomHarness('call', {
    texts: ['x'],
    stream: ['Eerste zin. en het slot'],
    answer: 'Eerste zin. en het slot',
  });
  h.room.mouth(() => true);
  await h.room.heard({ speaker: 'W', person: true, pcm });
  await h.settle();
  assert.deepEqual(
    h.ttsTexts,
    ['Eerste zin.', 'en het slot'],
    'the cut sentence, then the un-ended tail flushed at onAnswered',
  );
  await h.room.stop();
});

test('barge-in during synthesis drops the streamed answer unheard', async () => {
  let openTts = () => {};
  const h = roomHarness('call', {
    texts: ['vraag'],
    stream: ['Eerste zin. Tweede.'],
    answer: 'Eerste zin. Tweede.',
    ttsGate: () =>
      new Promise<void>(res => {
        openTts = res;
      }),
  });
  const played: Buffer[] = [];
  h.room.mouth(
    wav => {
      played.push(wav);
      return true;
    },
    () => {},
  );
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle();
  assert.deepEqual(
    h.ttsTexts,
    ['Eerste zin.'],
    'the first clause reached the voice; the wire is one voice at a time, so the second waits buffered',
  );
  assert.equal(played.length, 0, 'still synthesizing behind the gate');
  h.room.bargeIn();
  openTts();
  await h.settle();
  assert.equal(played.length, 0, 'the person spoke first: neither sentence plays');
  assert.deepEqual(h.ttsTexts, ['Eerste zin.'], 'the buffered clause died with the answer unheard');
  assert.ok(h.logs.includes('voice.reply.interrupted'), h.logs.join('\n'));
  await h.room.stop();
});

test('barge-in waits for a real word from a linked person', async () => {
  const h = roomHarness('call', { texts: ['vraag', 'laat maar'], answer: 'Een lang antwoord.' });
  let releasePlay = () => {};
  const played: Buffer[] = [];
  let stops = 0;
  const events: Array<Record<string, unknown>> = [];
  h.room.mouth(
    wav =>
      new Promise<boolean>(res => {
        played.push(wav);
        releasePlay = () => res(true);
      }),
    () => {
      stops++;
    },
  );
  h.room.onEvent(e => events.push(e));
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle(); // the turn ran; the answer is now playing (mouth gated open)
  assert.equal(played.length, 1, 'aivi is speaking the answer');
  await h.room.heard({ speaker: 'Wesley', person: true, pcm }); // the interruption, with words
  assert.ok(
    events.some(e => e.ev === 'stop_audio'),
    'words from a linked person interrupt at once',
  );
  assert.equal(stops, 1, 'the mouth is silenced');
  releasePlay();
  await h.room.stop();
});

test('a stranger speaking over a live answer does not silence aivi', async () => {
  const h = roomHarness('call', { texts: ['vraag', 'hallo'], answer: 'Een lang antwoord.' });
  let releasePlay = () => {};
  const events: Array<Record<string, unknown>> = [];
  h.room.mouth(
    () =>
      new Promise<boolean>(res => {
        releasePlay = () => res(true);
      }),
    () => {},
  );
  h.room.onEvent(e => events.push(e));
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle();
  await h.room.heard({ speaker: 'forger', person: false, pcm }); // a stranger talks over aivi
  assert.ok(!events.some(e => e.ev === 'stop_audio'), 'a stranger cannot interrupt a live answer');
  releasePlay();
  await h.room.stop();
});

// Live lanes: the platform's demuxed speaker streams in, words come back
// while they are still talking, and the first word decides an interruption.

test('live lane: the first word of a linked person interrupts; the streamed text becomes the prompt', async () => {
  const h = roomHarness('call', { texts: ['vraag'], answer: 'Een lang antwoord.' });
  let releasePlay = () => {};
  const played: Buffer[] = [];
  let stops = 0;
  const events: Array<Record<string, unknown>> = [];
  h.room.mouth(
    wav =>
      new Promise<boolean>(res => {
        played.push(wav);
        releasePlay = () => res(true);
      }),
    () => {
      stops++;
    },
  );
  h.room.onEvent(e => events.push(e));
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle(); // the answer is playing (mouth gated open)
  assert.equal(played.length, 1, 'aivi is mid-answer');
  const lane = h.room.lane({ speaker: 'Wesley', user: 'u1', person: true });
  lane.push(pcm);
  await new Promise(res => setTimeout(res, 10)); // the engine joins the lane (async, like a child)
  assert.ok(h.laneCalls.includes('w:call:test/1'), 'audio reaches a live lane of its own in the shared engine');
  h.emitLane({ ev: 'delta', text: 'Nee', pos: 0.1, lane: 'call:test/1' });
  assert.ok(
    events.some(e => e.ev === 'stop_audio'),
    'the first recognized word interrupts at once',
  );
  assert.equal(stops, 1, 'the mouth is silenced on the word, not the speaking start');
  h.emitLane({ ev: 'delta', text: ' hè?', pos: 0.2, lane: 'call:test/1' });
  releasePlay();
  const text = await lane.end(); // endLane flushes; lane_end lands async
  assert.equal(text, 'Nee hè?', 'the line is exactly what streamed live');
  await h.settle();
  assert.ok(
    h.calls.some(c => String(c.text).includes('Nee hè?')),
    'the streamed words went to the session as one prompt',
  );
  await h.room.stop();
});

test('the live lane of a stranger is heard but never silences aivi', async () => {
  const h = roomHarness('call', { texts: ['vraag'], answer: 'Een lang antwoord.' });
  let releasePlay = () => {};
  const events: Array<Record<string, unknown>> = [];
  h.room.mouth(
    () =>
      new Promise<boolean>(res => {
        releasePlay = () => res(true);
      }),
    () => {},
  );
  h.room.onEvent(e => events.push(e));
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await h.settle();
  const lane = h.room.lane({ speaker: 'forger', user: 'u2', person: false });
  lane.push(pcm);
  await new Promise(res => setTimeout(res, 10));
  h.emitLane({ ev: 'delta', text: 'ho', pos: 0.1, lane: 'call:test/1' });
  assert.ok(!events.some(e => e.ev === 'stop_audio'), 'the word of a stranger cannot interrupt a live answer');
  releasePlay();
  await lane.end();
  await h.room.stop();
});

test('a lane whose engine dies commits what streamed, and says partial', async () => {
  const h = roomHarness('call', { noLaneEnd: true });
  h.room.mouth(() => true);
  const lane = h.room.lane({ speaker: 'Wesley', user: 'u1', person: true });
  lane.push(pcm);
  await new Promise(res => setTimeout(res, 10));
  h.emitLane({ ev: 'delta', text: 'halverwege', pos: 0.1, lane: 'call:test/1' });
  const done = lane.end(); // waits for the tail the dead engine will never send
  await new Promise(res => setTimeout(res, 10));
  h.emitLaneState('failed'); // the engine died; waiting must not hang
  assert.equal(await done, 'halverwege', 'the line is what streamed so far');
  assert.ok(h.logs.includes('voice.lane.partial'), h.logs.join('\n'));
  await h.room.stop();
});

test('a lane the engine never joined is batch-transcribed', async () => {
  const h = roomHarness('call', { engineNull: true, stt: 'uit de batch-lane' });
  h.room.mouth(() => true);
  const lane = h.room.lane({ speaker: 'Wesley', user: 'u1', person: true });
  lane.push(pcm);
  await new Promise(res => setTimeout(res, 10));
  assert.equal(h.laneCalls.length, 0, 'no live lane without an engine');
  assert.equal(await lane.end(), 'uit de batch-lane', 'the buffered audio went through the batch lane');
  await h.room.stop();
});

test('a sentence plays as chunks; a barge between chunks leaves the rest unheard', async () => {
  let openChunks = () => {};
  const h = roomHarness('call', {
    texts: ['vraag'],
    answer: 'antwoord',
    ttsChunks: ['chunk-a', 'chunk-b'],
    chunkGate: () =>
      new Promise<void>(res => {
        openChunks = res;
      }),
  });
  const played: string[] = [];
  h.room.mouth(
    w => {
      played.push(w.toString());
      return true;
    },
    () => {},
  );
  await h.room.heard({ speaker: 'Wesley', person: true, pcm });
  await new Promise(res => setTimeout(res, 120)); // flush + turn: first chunk out, voice holds the second
  assert.deepEqual(played, ['chunk-a'], 'the first chunk played while the sentence was still being synthesized');
  h.room.bargeIn();
  openChunks();
  await h.settle();
  assert.deepEqual(played, ['chunk-a'], 'the person spoke: the rest of the sentence goes unheard');
  assert.ok(h.logs.includes('voice.reply.interrupted'), h.logs.join('\n'));
  await h.room.stop();
});
