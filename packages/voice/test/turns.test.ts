import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import type { AnswerText } from '../src/turns.ts';
import { boundary } from './boundary.ts';
import { voiceTurns } from './turns-fixture.ts';

const line = (text: string, ...speakers: string[]) => ({ text, speakers });

test('a line takes a slot, gets its session from the pool, asks the model and returns the slot', async t => {
  const h = voiceTurns(t, {
    config: { pool: 'voice-local', transcript: 7, model: { providerID: 'local', modelID: 'voxtral' } },
  });
  const answered = t.mock.fn<(text: string) => void>();
  const state = t.mock.fn<(state: string) => void>();
  h.turns.onAnswered = answered;
  h.turns.onTurnState = state;

  h.turns.prompt({ text: 'hello', speakers: ['Ada', 'Grace'], wake: 'hey assistant' });
  const [input, options] = await h.asked.next();

  assert.deepEqual(h.request.mock.calls[0]!.arguments, [{ service: 'voice', pool: 'voice-local' }]);
  assert.deepEqual(h.provide.mock.calls[0]!.arguments, ['lease-1', { agent: 'assistant', directory: '/voice' }]);
  assert.match(String(input.messageId), /^msg_voice_[0-9a-z]+_[0-9a-z]+$/);
  assert.deepEqual(input, {
    sessionId: 'ses_voice_1',
    agent: 'assistant',
    directory: '/voice',
    create: false,
    messageId: input.messageId,
    text: 'hello',
    messageMetadata: {
      aivi: { origin: 'discord', transcript: 7, speakers: ['Ada', 'Grace'], wake: 'hey assistant' },
    },
    model: { providerID: 'local', modelID: 'voxtral' },
  });
  assert.equal(options.events, h.deps.events);
  assert.equal(options.onPermission, 'reject');
  assert.equal((options.signal as AbortSignal).aborted, false);
  assert.deepEqual(
    h.rememberLease.mock.calls.map(call => call.arguments[0]),
    ['lease-1'],
    'the held slot is persisted while the model works',
  );
  h.answers[0]!.resolve({ text: 'hi there' });
  await h.moved.next();
  assert.deepEqual(answered.mock.calls[0]!.arguments, ['hi there']);
  assert.deepEqual(
    state.mock.calls.map(call => call.arguments[0]),
    ['thinking', 'idle'],
  );
  assert.deepEqual(
    h.rememberSession.mock.calls.map(call => call.arguments[0]),
    ['ses_voice_1'],
  );
  assert.deepEqual(
    h.rememberLease.mock.calls.map(call => call.arguments[0]),
    ['lease-1', null],
  );
  assert.deepEqual(
    h.release.mock.calls.map(call => call.arguments[0]),
    ['lease-1'],
  );
  assert.deepEqual(
    h.info.mock.calls.map(call => call.arguments),
    [['turns.started', { session: 'ses_voice_1', chars: 5 }]],
  );
  assert.equal(h.watch.mock.callCount(), 1, 'a watched room hears the turn');
  assert.equal(h.unwatch.mock.callCount(), 1);
});

test('lines are answered one at a time, and the next one resumes the room session on its own slot', async t => {
  const h = voiceTurns(t);
  h.turns.retry();
  assert.equal(h.request.mock.callCount(), 0, 'a room with nothing to say asks for no slot');

  h.turns.prompt(line('first', 'Ada'));
  const [first] = await h.asked.next();
  h.turns.prompt(line('second'));
  assert.equal(h.request.mock.callCount(), 1, 'the second line waits for the running turn');
  h.answers[0]!.resolve({ text: 'one' });
  const [second] = await h.asked.next();

  assert.deepEqual(h.request.mock.calls[1]!.arguments, [{ service: 'voice', resume: 'ses_voice_1' }]);
  assert.equal(h.provide.mock.callCount(), 1, 'a resumed lease already carries its session');
  assert.equal(second.sessionId, 'ses_voice_1');
  assert.equal(second.text, 'second');
  assert.deepEqual(second.messageMetadata, { aivi: { origin: 'discord' } }, 'nothing is invented for a nameless line');
  assert.equal('model' in second, false);
  assert.notEqual(second.messageId, first.messageId);
  assert.equal(h.watch.mock.callCount(), 0, 'nobody listens for answer text in a room without a face or a mouth');
});

test('a call room steers the running turn with the new words instead of taking a second slot', async t => {
  const h = voiceTurns(t, { config: { steerWhenBusy: true, transcript: 3 } });
  const steered = boundary();
  h.steer.mock.mockImplementation(async () => {
    steered.reach();
  });
  h.turns.prompt(line('work on it', 'Ada'));
  const [running] = await h.asked.next();

  h.turns.prompt(line('go left', 'Grace'));
  await steered.next();
  h.turns.prompt(line('and faster'));
  await steered.next();

  const [named, nameless] = h.steer.mock.calls.map(call => call.arguments[0]);
  assert.deepEqual(named, {
    sessionID: 'ses_voice_1',
    id: named!.id,
    text: 'go left',
    delivery: 'steer',
    metadata: {
      aivi: { origin: 'discord', mode: 'call', transcript: 3, speakers: ['Grace'], steer: running.messageId },
    },
  });
  assert.deepEqual((nameless!.metadata as { aivi: object }).aivi, {
    origin: 'discord',
    mode: 'call',
    transcript: 3,
    steer: running.messageId,
  });
  assert.notEqual(named!.id, running.messageId);
  assert.equal(h.request.mock.callCount(), 1, 'steering borrows no second slot');
});

test('a steer that fails is said and costs nothing else', async t => {
  const h = voiceTurns(t, { config: { steerWhenBusy: true } });
  const warned = boundary();
  h.warn.mock.mockImplementation(() => warned.reach());
  h.steer.mock.mockImplementation(async () => {
    throw new Error('session busy');
  });
  h.turns.prompt(line('work on it'));
  const [running] = await h.asked.next();

  h.turns.prompt(line('go left'));
  await warned.next();

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['turns.steer.failed', { error: 'Error: session busy' }]],
  );
  assert.deepEqual((h.steer.mock.calls[0]!.arguments[0].metadata as { aivi: object }).aivi, {
    origin: 'discord',
    mode: 'call',
    steer: running.messageId,
  });
});

test('words that land while a call room is still getting its session wait their turn', async t => {
  const h = voiceTurns(t, { config: { steerWhenBusy: true } });
  const preparing = boundary();
  const prepared = Promise.withResolvers<DispatcherLeaseRef>();
  h.provide.mock.mockImplementationOnce(() => {
    preparing.reach();
    return prepared.promise;
  });
  h.turns.prompt(line('first'));
  await preparing.next();

  h.turns.prompt(line('second'));
  prepared.resolve({ ...h.lease('lease-1', 'active'), sessionId: 'ses_voice_new' });
  await h.asked.next();
  h.answers[0]!.resolve({ text: 'one' });
  const [second] = await h.asked.next();

  assert.equal(h.steer.mock.callCount(), 0, 'there was no session to steer yet');
  assert.equal(second.text, 'second');
  assert.equal(second.sessionId, 'ses_voice_new');
});

test('a full pool keeps the line: the queue place becomes its slot when capacity frees', async t => {
  const h = voiceTurns(t);
  h.request.mock.mockImplementationOnce(() => ({ queued: 'req-1' }));

  h.turns.prompt(line('later'));
  h.turns.prompt(line('and after that'));
  h.turns.retry();

  assert.equal(h.request.mock.callCount(), 1, 'one queue place is all a room holds while it waits');
  assert.deepEqual(h.requestSeat.mock.calls[0]!.arguments, ['req-1', h.turns]);
  assert.deepEqual(h.said('info'), ['turns.queued']);
  h.turns.fulfill(h.lease('lease-queued'));
  const [input] = await h.asked.next();
  assert.deepEqual(h.releaseSeat.mock.calls[0]!.arguments, ['req-1']);
  assert.equal(h.provide.mock.calls[0]!.arguments[0], 'lease-queued');
  assert.equal(input.text, 'later');
});

test('a slot handed over when nobody waits for it goes straight back', async t => {
  const h = voiceTurns(t);

  h.turns.fulfill(h.lease('lease-idle'));
  await h.moved.next();
  h.turns.prompt(line('busy now'));
  await h.asked.next();
  h.release.mock.mockImplementationOnce(async id => ({ pending: { id, pool: 'voice-local', state: 'expiring' } }));
  h.turns.fulfill(h.lease('lease-busy'));
  await h.moved.next();

  assert.deepEqual(
    h.release.mock.calls.map(call => call.arguments[0]),
    ['lease-idle', 'lease-busy'],
  );
  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['turns.lease.pending-kill', { lease: 'lease-busy', pool: 'voice-local' }]],
  );
  assert.equal(h.releaseSeat.mock.callCount(), 0, 'no queue place was held');
  assert.equal(h.runTurn.mock.callCount(), 1);
});

test('a refused request keeps the line until another voice release brings it back', async t => {
  const h = voiceTurns(t, { config: { pool: 'voice-local' } });
  h.request.mock.mockImplementationOnce(() => ({ refused: 'waiting', pool: 'voice-local' }));

  h.turns.prompt(line('patient'));

  assert.deepEqual(
    h.info.mock.calls.map(call => call.arguments),
    [
      [
        'turns.refused',
        {
          refused: 'waiting',
          pool: 'voice-local',
          hint: 'another voice room holds the queue place; a released lease brings this back',
        },
      ],
    ],
  );
  assert.equal(h.runTurn.mock.callCount(), 0);
  h.turns.retry();
  const [input] = await h.asked.next();
  assert.equal(input.text, 'patient');
});

test('a pool the dispatcher does not know is said loudly and the line waits for the configuration', async t => {
  const h = voiceTurns(t, { config: { pool: 'typo' } });
  h.request.mock.mockImplementationOnce(() => {
    throw new Error('pool "typo" is not configured');
  });

  h.turns.prompt(line('kept'));

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['turns.pool.missing', { error: 'Error: pool "typo" is not configured', hint: 'voice.pool: typo' }]],
  );
  h.turns.retry();
  const [input] = await h.asked.next();
  assert.equal(input.text, 'kept');
});

test('a remembered session that OpenCode no longer has is replaced once, and the line is asked again', async t => {
  const h = voiceTurns(t, { session: 'ses_voice_stale' });

  h.turns.prompt(line('are you there?', 'Ada'));
  const [stale] = await h.asked.next();
  h.answers[0]!.reject(new Error('Session not found: ses_voice_stale'));
  const [fresh] = await h.asked.next();

  assert.deepEqual(h.request.mock.calls[0]!.arguments, [{ service: 'voice', resume: 'ses_voice_stale' }]);
  assert.equal(stale.sessionId, 'ses_voice_stale');
  assert.deepEqual(h.request.mock.calls[1]!.arguments, [{ service: 'voice' }], 'the retry asks for a new session');
  assert.equal(fresh.sessionId, 'ses_voice_1');
  assert.equal(fresh.text, 'are you there?', 'the line went out again, not lost');
  assert.equal(h.clearSession.mock.callCount(), 1);
  assert.deepEqual(h.info.mock.calls.find(call => call.arguments[0] === 'turns.session.stale')!.arguments[1], {
    room: 'discord',
    session: 'ses_voice_stale',
    hint: 'the persisted session is gone; this room starts a fresh one',
  });
  assert.deepEqual(h.said('warn'), [], 'a replaced session is not a failure');
});

test('a room whose fresh session is missing too says so instead of replacing sessions forever', async t => {
  const h = voiceTurns(t, { session: 'ses_voice_stale' });
  h.turns.prompt(line('first'));
  await h.asked.next();
  h.answers[0]!.reject(new Error('Session not found: ses_voice_stale'));
  await h.asked.next();
  await h.moved.next();

  h.answers[1]!.reject(new Error('Session not found: ses_voice_1'));
  await h.moved.next();

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['turns.failed', { error: 'Error: Session not found: ses_voice_1' }]],
  );
  assert.equal(h.runTurn.mock.callCount(), 2, 'one strike: the line is not asked a third time');
  h.turns.prompt(line('next line'));
  await h.asked.next();
  h.answers[2]!.resolve({ text: 'here' });
  await h.moved.next();
  h.turns.prompt(line('much later'));
  await h.asked.next();
  h.answers[3]!.reject(new Error('Session not found: ses_voice_1'));
  const [again] = await h.asked.next();
  assert.equal(again.text, 'much later', 'an answered turn earns the room a new strike');
});

test('a turn that fails is said, returns its slot and lets the next line through', async t => {
  const h = voiceTurns(t);
  const answered = t.mock.fn();
  h.turns.onAnswered = answered;
  h.provide.mock.mockImplementationOnce(async () => {
    throw new Error('session could not be created');
  });
  h.opencode.mock.mockImplementationOnce(async () => {
    throw new Error('OpenCode is not running');
  });

  h.turns.prompt(line('never prepared'));
  await h.moved.next();
  h.turns.prompt(line('never connected'));
  await h.moved.next();
  h.turns.prompt(line('never answered'));
  await h.asked.next();
  h.answers[0]!.reject(new Error('the model gave up'));
  await h.moved.next();

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [
      ['turns.failed', { error: 'Error: session could not be created' }],
      ['turns.failed', { error: 'Error: OpenCode is not running' }],
      ['turns.failed', { error: 'Error: the model gave up' }],
    ],
  );
  assert.deepEqual(
    h.release.mock.calls.map(call => call.arguments[0]),
    ['lease-1', 'lease-2', 'lease-3'],
  );
  assert.equal(answered.mock.callCount(), 0);
  assert.equal(h.unwatch.mock.callCount(), h.watch.mock.callCount(), 'no failed turn leaves a watcher behind');
});

test('a slot that cannot be returned is said, and the room still moves on', async t => {
  const h = voiceTurns(t);
  const lost = boundary();
  h.warn.mock.mockImplementation(() => lost.reach());
  h.release.mock.mockImplementationOnce(async () => {
    throw new Error('Lease lease-1 was already gone');
  });
  h.turns.prompt(line('first'));
  h.turns.prompt(line('second'));
  await h.asked.next();

  h.answers[0]!.resolve({ text: 'one' });
  await lost.next();
  const [second] = await h.asked.next();

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['turns.lease.lost', { error: 'Error: Lease lease-1 was already gone' }]],
  );
  assert.equal(h.capacityMoved.mock.callCount(), 0, 'no capacity moved');
  assert.equal(second.text, 'second');
});

test('a release whose kill is unconfirmed is said once and still wakes the other rooms', async t => {
  const h = voiceTurns(t);
  h.release.mock.mockImplementationOnce(async id => ({ pending: { id, pool: 'voice-local', state: 'expiring' } }));
  h.turns.prompt(line('first'));
  await h.asked.next();

  h.answers[0]!.resolve({ text: 'one' });
  await h.moved.next();

  assert.deepEqual(
    h.warn.mock.calls.map(call => call.arguments),
    [['turns.lease.pending-kill', { lease: 'lease-1', pool: 'voice-local' }]],
  );
});

test('the answer is passed on as it is written, and the face follows the tools', async t => {
  const h = voiceTurns(t);
  const text = t.mock.fn<(event: AnswerText) => void>();
  const state = t.mock.fn<(state: string) => void>();
  h.turns.onText = text;
  h.turns.onTurnState = state;
  h.turns.prompt(line('tell me'));
  await h.asked.next();

  h.emit({ type: 'session.text.started', data: { assistantMessageID: 'msg-1' } });
  h.emit({ type: 'session.text.delta', data: { assistantMessageID: 'msg-1', delta: 'Hel' } });
  h.emit({ type: 'session.text.delta', data: { assistantMessageID: 'msg-1', delta: '' } });
  h.emit({ type: 'session.text.delta', data: { assistantMessageID: 'msg-1', delta: 42 } });
  h.emit({ type: 'session.text.delta', data: { delta: 'no message id' } });
  h.emit({ type: 'session.text.delta' });
  h.emit({ type: 'session.step.finished', data: { assistantMessageID: 'msg-1' } });
  h.emit({ type: 'session.tool.called', data: {} });
  h.emit({ type: 'session.tool.success', data: {} });
  h.emit({ type: 'session.tool.called', data: {} });
  h.emit({ type: 'session.tool.failed', data: {} });

  assert.equal(h.watch.mock.calls[0]!.arguments[0], 'ses_voice_1');
  assert.deepEqual(
    text.mock.calls.map(call => call.arguments[0]),
    [
      { kind: 'start', messageID: 'msg-1' },
      { kind: 'delta', messageID: 'msg-1', delta: 'Hel' },
    ],
  );
  assert.deepEqual(
    state.mock.calls.map(call => call.arguments[0]),
    ['thinking', 'tool', 'thinking', 'tool', 'thinking'],
  );
  h.answers[0]!.resolve({ text: 'Hello' });
  await h.moved.next();
  h.emit({ type: 'session.text.delta', data: { assistantMessageID: 'msg-1', delta: 'late' } });
  assert.equal(text.mock.callCount(), 2, 'the turn is over: nobody listens anymore');
  assert.equal(state.mock.calls.at(-1)!.arguments[0], 'idle');
});

test('a room with only a mouth hears the text, and a room with only a face sees the tools', async t => {
  for (const hook of ['text', 'state'] as const) {
    await t.test(hook, async t => {
      const h = voiceTurns(t);
      const text = t.mock.fn();
      const state = t.mock.fn();
      if (hook === 'text') h.turns.onText = text;
      else h.turns.onTurnState = state;
      h.turns.prompt(line('tell me'));
      await h.asked.next();

      h.emit({ type: 'session.tool.called', data: {} });
      h.emit({ type: 'session.text.started', data: { assistantMessageID: 'msg-1' } });

      assert.equal(text.mock.callCount(), hook === 'text' ? 1 : 0);
      assert.deepEqual(
        state.mock.calls.map(call => call.arguments[0]),
        hook === 'state' ? ['thinking', 'tool'] : [],
      );
    });
  }
});

test('leaving drops the waiting lines and cuts the answer nobody is left to hear', async t => {
  const h = voiceTurns(t);
  h.turns.prompt(line('a long question'));
  h.turns.prompt(line('never asked'));
  const [, options] = await h.asked.next();

  await h.turns.stop();

  assert.equal(h.interrupt.mock.calls[0]!.arguments[0].sessionID, 'ses_voice_1');
  assert.equal((options.signal as AbortSignal).aborted, true);
  assert.deepEqual(h.info.mock.calls.at(-1)!.arguments, [
    'turns.cut',
    { hint: 'the room left while the model was still answering' },
  ]);
  assert.deepEqual(h.said('warn'), [], 'a cut answer is not a failed one');
  assert.deepEqual(
    h.release.mock.calls.map(call => call.arguments[0]),
    ['lease-1'],
  );
  assert.equal(h.request.mock.callCount(), 1, 'the waiting line was dropped, not asked');
  h.turns.prompt(line('after the room closed'));
  h.turns.fulfill(h.lease('lease-late'));
  await h.moved.next();
  assert.equal(h.runTurn.mock.callCount(), 1);
  assert.equal(h.release.mock.calls.at(-1)!.arguments[0], 'lease-late');
});

test('leaving gives up the queue place, and a refused interrupt still cuts the wait', async t => {
  const queued = voiceTurns(t);
  queued.request.mock.mockImplementationOnce(() => ({ queued: 'req-1' }));
  queued.turns.prompt(line('waiting for capacity'));

  await queued.turns.stop();

  assert.deepEqual(queued.cancel.mock.calls[0]!.arguments, ['req-1']);
  assert.deepEqual(queued.releaseSeat.mock.calls[0]!.arguments, ['req-1']);
  const running = voiceTurns(t);
  running.interrupt.mock.mockImplementationOnce(async () => {
    throw new Error('OpenCode is gone');
  });
  running.turns.prompt(line('a long question'));
  await running.asked.next();
  await running.turns.stop();
  assert.deepEqual(
    running.warn.mock.calls.map(call => call.arguments),
    [['turns.interrupt.failed', { error: 'Error: OpenCode is gone' }]],
  );
  assert.deepEqual(running.said('info').at(-1), 'turns.cut');
});
