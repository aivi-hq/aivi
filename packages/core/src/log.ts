/**
 * Minimal structured logger: one JSON object per line on stderr. stdout stays
 * reserved for command output so `aivi ... | jq` keeps working.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}, base: LogFields = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? (line => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const emit = (lvl: LogLevel, event: string, fields?: LogFields) => {
    if (order[lvl] < order[level]) return;
    write(JSON.stringify({ time: now().toISOString(), level: lvl, event, ...base, ...(fields ? serializable(fields) : {}) }));
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: fields => createLogger(options, { ...base, ...fields }),
  };
}

export const silentLogger: Logger = createLogger({ write: () => {} });

/** Errors do not JSON.stringify usefully; flatten them to message + name. */
function serializable(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message } : key === 'error' ? errorMessage(value) : value;
  }
  return out;
}

/** OpenCode's client rejects with plain tagged objects, not Errors; read their message too. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const tag = '_tag' in error && typeof error._tag === 'string' ? `${error._tag}: ` : '';
    return `${tag}${error.message}`;
  }
  return String(error);
}
