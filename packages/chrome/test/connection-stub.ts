import type { TestContext } from 'node:test';
import type { CdpConnection } from '../src/index.ts';

/** What `Tab` and `Chrome` reach: a connection whose `send` answers from
 *  `answers` by method (a function is called with the params and what it
 *  returns is the answer, anything else is the answer itself) and records
 *  what it was asked. Events are for the test to dispatch on it. */
export function stubConnection(t: TestContext, answers: Record<string, unknown> = {}) {
  const send = t.mock.fn(async (method: string, params?: object, _sessionId?: string): Promise<unknown> => {
    const answer = answers[method];
    return typeof answer === 'function' ? answer(params) : answer;
  });
  const stub = Object.assign(new EventTarget(), {
    answers,
    send,
    close: t.mock.fn(),
    /** The commands sent so far, as `[method, params, sessionId]`. */
    sent: (): unknown[][] => send.mock.calls.map(call => [...call.arguments]),
  });
  return stub as unknown as CdpConnection & typeof stub;
}
