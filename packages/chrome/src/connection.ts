/**
 * One websocket to one Chrome browser: the bottom of the protocol. Commands
 * are matched to their answers by id. A command carrying a session id
 * addresses one tab; without one it addresses the browser itself. Events
 * arrive named `Domain.event` and carry the session they belong to.
 *
 * There is no silent reconnection. A socket to a browser we launched dies
 * with it, and hiding that would turn a dead meeting into a hung process:
 * calls still waiting reject as closed, and the `close` event says it
 * happened.
 */

/** A protocol answer or a connection trouble, either way with a `code`.
 *  Answers from the browser carry the protocol's numeric codes (e.g. -32601
 *  for a method that does not exist); our own troubles use the string
 *  constants exported below. */
export class CdpError extends Error {
  readonly code: number | string;

  constructor(message: string, code: number | string) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

export const CONNECTION_CLOSED = 'connectionClosed';
export const CONNECTION_REFUSED = 'connectionRefused';
export const CONNECTION_TIMED_OUT = 'connectionTimedOut';
export const COMMAND_TIMED_OUT = 'commandTimedOut';

/** A protocol event (`Page.loadEventFired` and friends). `sessionId` is the
 *  tab the event came from, undefined for browser-level events. */
export class CdpEvent extends Event {
  readonly params: Record<string, unknown> | undefined;
  readonly sessionId: string | undefined;

  constructor(
    type: string,
    init: { params?: Record<string, unknown> | undefined; sessionId?: string | undefined } = {},
  ) {
    super(type);
    this.params = init.params;
    this.sessionId = init.sessionId;
  }
}

/** A one-shot wait. This package's only timer: polling is honest when the
 *  protocol reports events like "the page loaded" but not "an element
 *  finally exists", and puppeteer and playwright poll the same way. Nothing
 *  here repeats on a schedule; every sleep belongs to a bounded wait that a
 *  caller started and can end. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface CdpConnectionOptions {
  /** Reject a command whose answer never arrives, after this many
   *  milliseconds. The connection stays usable: the protocol cannot cancel a
   *  command once it is sent, so the browser may still have acted on it.
   *  Default 30000, 0 to disable. */
  commandMaxTime?: number;
  /** Bound the websocket handshake itself. Default 10000. */
  connectMaxTime?: number;
}

interface Pending {
  method: string;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const DEFAULT_COMMAND_MAX_TIME = 30_000;
const DEFAULT_CONNECT_MAX_TIME = 10_000;

export class CdpConnection extends EventTarget {
  readonly #wsUrl: string;
  readonly #commandMaxTime: number;
  readonly #connectMaxTime: number;
  readonly #pending = new Map<number, Pending>();
  #ws: WebSocket | undefined;
  #nextId = 0;
  #closed = false;

  private constructor(wsUrl: string, options: CdpConnectionOptions) {
    super();
    this.#wsUrl = wsUrl;
    this.#commandMaxTime = options.commandMaxTime ?? DEFAULT_COMMAND_MAX_TIME;
    this.#connectMaxTime = options.connectMaxTime ?? DEFAULT_CONNECT_MAX_TIME;
  }

  /** Open the socket and fail fast if nothing answers. A caller waiting for
   *  a booting browser retries at its own level, where it also watches that
   *  browser's process. */
  static async open(wsUrl: string, options: CdpConnectionOptions = {}): Promise<CdpConnection> {
    const connection = new CdpConnection(wsUrl, options);
    await connection.#connect();
    return connection;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #connect(): Promise<void> {
    const ws = new WebSocket(this.#wsUrl);
    this.#ws = ws;
    ws.addEventListener('message', event => this.#onMessage(event.data));
    ws.addEventListener('close', event => {
      this.#ws = undefined;
      this.#drain(event.reason === '' ? undefined : ` (${event.reason})`);
      if (!this.#closed) {
        this.#closed = true;
        this.dispatchEvent(new Event('close'));
      }
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(error);
      };
      timer = setTimeout(
        () => fail(new CdpError(`socket not opened within ${this.#connectMaxTime} ms`, CONNECTION_TIMED_OUT)),
        this.#connectMaxTime,
      );
      ws.addEventListener(
        'open',
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => fail(new CdpError(`could not reach the browser at ${this.#wsUrl}`, CONNECTION_REFUSED)),
        { once: true },
      );
    });
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const ws = this.#ws;
    if (this.#closed || ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError(`connection closed when calling ${method}`, CONNECTION_CLOSED));
    }
    const id = this.#nextId;
    this.#nextId = (this.#nextId + 1) % Number.MAX_SAFE_INTEGER;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        this.#commandMaxTime === 0
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(id);
              reject(new CdpError(`no answer for ${method} within ${this.#commandMaxTime} ms`, COMMAND_TIMED_OUT));
            }, this.#commandMaxTime);
      this.#pending.set(id, { method, resolve: resolve as (value: never) => void, reject, timer });
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        if (timer !== undefined) clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError(`send failed when calling ${method}: ${String(error)}`, CONNECTION_CLOSED));
      }
    });
  }

  /** Close the socket. Waiting calls reject; listeners are not kept, so a
   *  consumer that wants to reconnect builds it with its own knowledge. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#drain(' by us');
    this.#ws?.close();
    this.dispatchEvent(new Event('close'));
  }

  #onMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending !== undefined) {
        this.#pending.delete(message.id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        if (message.error === undefined) {
          pending.resolve(message.result as never);
        } else {
          pending.reject(
            new CdpError(
              `${message.error.message ?? 'protocol error'} when calling ${pending.method}`,
              message.error.code ?? -32000,
            ),
          );
        }
      }
    }
    if (message.method !== undefined) {
      this.dispatchEvent(new CdpEvent(message.method, { params: message.params, sessionId: message.sessionId }));
    }
  }

  #drain(reasonSuffix?: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(
        new CdpError(`connection closed${reasonSuffix ?? ''} when calling ${pending.method}`, CONNECTION_CLOSED),
      );
    }
    this.#pending.clear();
  }
}
