import type { TestContext } from 'node:test';
import type { Logger } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin';
import type { Dispatcher, DispatcherLeaseRef } from '@aivi/plugin/dispatcher';
import type { SessionEvent, SessionEventListener } from '@aivi/plugin/module';
import { type TurnsConfig, type TurnsDeps, VoiceTurns } from '../src/turns.ts';
import { boundary } from './boundary.ts';

/** One room's turn runner with every collaborator recorded and nothing
 *  alive: the dispatcher grants on request, OpenCode is a client-shaped
 *  fake, and each model answer is a promise the test settles. */
export function voiceTurns(t: TestContext, options: { config?: Partial<TurnsConfig>; session?: string } = {}) {
  const info = t.mock.fn();
  const warn = t.mock.fn();
  let leases = 0;
  let sessions = 0;
  const request = t.mock.fn<Dispatcher['request']>(input => ({
    lease: {
      id: `lease-${++leases}`,
      pool: input.pool ?? 'default',
      state: input.resume ? 'active' : 'preparing',
      ...(input.resume ? { sessionId: input.resume } : {}),
    },
  }));
  const provide = t.mock.fn<Dispatcher['provide']>(async id => ({
    id,
    pool: 'default',
    state: 'active',
    sessionId: `ses_voice_${++sessions}`,
  }));
  const release = t.mock.fn<Dispatcher['release']>(async id => ({ ended: { id, pool: 'default', state: 'active' } }));
  const cancel = t.mock.fn<Dispatcher['cancel']>();
  const steer = t.mock.fn(async (_prompt: Record<string, unknown>) => {});
  const interrupt = t.mock.fn(async (_session: { sessionID: string }, _request: { signal: AbortSignal }) => {});
  const client = { session: { prompt: steer, interrupt } } as unknown as OpenCodeClient;
  const opencode = t.mock.fn<TurnsDeps['opencode']>(async () => client);
  // The model at work: every turn reaches `asked` with what it was given and
  // stays there until the test answers it.
  const asked = boundary<[input: Record<string, unknown>, options: Record<string, unknown>]>();
  const answers: PromiseWithResolvers<{ text: string }>[] = [];
  const runTurn = t.mock.fn<TurnsDeps['runTurn']>((_client, input, turn) => {
    const answer = Promise.withResolvers<{ text: string }>();
    answers.push(answer);
    asked.reach(input, turn);
    return answer.promise;
  });
  const remembered = { session: options.session };
  const session = t.mock.fn<TurnsDeps['session']>(() => remembered.session);
  const rememberSession = t.mock.fn<TurnsDeps['rememberSession']>(id => {
    remembered.session = id;
  });
  const clearSession = t.mock.fn<TurnsDeps['clearSession']>(() => {
    remembered.session = undefined;
  });
  const rememberLease = t.mock.fn<TurnsDeps['rememberLease']>();
  const requestSeat = t.mock.fn<TurnsDeps['requestSeat']>();
  const releaseSeat = t.mock.fn<TurnsDeps['releaseSeat']>();
  // The last thing a finished turn does before it looks for the next line.
  const moved = boundary();
  const capacityMoved = t.mock.fn<TurnsDeps['capacityMoved']>(() => moved.reach());
  const host = new AbortController();
  const watchers = new Set<SessionEventListener>();
  const unwatch = t.mock.fn();
  const watch = t.mock.fn((_session: string, listener: SessionEventListener) => {
    watchers.add(listener);
    return () => {
      watchers.delete(listener);
      unwatch();
    };
  });
  const turns = new VoiceTurns(
    { agent: 'assistant', directory: '/voice', steerWhenBusy: false, origin: 'discord', ...options.config },
    {
      dispatcher: { request, provide, release, cancel } as unknown as Dispatcher,
      opencode,
      runTurn,
      session,
      rememberSession,
      clearSession,
      rememberLease,
      requestSeat,
      releaseSeat,
      capacityMoved,
      servicesSignal: host.signal,
      events: { watch },
      log: { info, warn } as unknown as Logger,
    },
  );
  t.after(() => {
    for (const answer of answers) answer.resolve({ text: '' });
    return turns.stop();
  });
  const lease = (id: string, state: DispatcherLeaseRef['state'] = 'preparing'): DispatcherLeaseRef => ({
    id,
    pool: 'default',
    state,
  });
  return {
    turns,
    info,
    warn,
    request,
    provide,
    release,
    cancel,
    steer,
    interrupt,
    opencode,
    runTurn,
    asked,
    answers,
    session,
    rememberSession,
    clearSession,
    rememberLease,
    requestSeat,
    releaseSeat,
    capacityMoved,
    moved,
    host,
    watch,
    unwatch,
    lease,
    /** One event on the session's stream, to whoever watches right now. */
    emit: (event: SessionEvent) => {
      for (const listener of [...watchers]) listener(event);
    },
    /** What the log said, by level: the message names in order. */
    said: (level: 'info' | 'warn') => (level === 'info' ? info : warn).mock.calls.map(call => call.arguments[0]),
  };
}
