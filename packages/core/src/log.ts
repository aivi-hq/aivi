import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getRotatingFileSink } from '@logtape/file';
import {
  configure,
  dispose,
  getJsonLinesFormatter,
  type LogRecord,
  type LogLevel as LogTapeLogLevel,
  type Sink,
} from '@logtape/logtape';
import { getPrettyFormatter, type PrettyFormatterOptions } from '@logtape/pretty';

// LogTape is the logger, and this module is its only doorway in the
// workspace: components get handles from `getLogger(['aivi', 'host'])`,
// per-run fields attach with `logger.with({ run })`, and whether anything is
// written at all is decided once, at startup, by `configureLogging` — the
// registry it fills is process-global, so a handle made in any package lands
// in the one configured tree. An unconfigured process — tests, or a process
// that died before setup — logs nowhere, which is what keeps tests quiet
// without a stub. No other package depends on @logtape directly.
export type { Logger } from '@logtape/logtape';
export { getLogger } from '@logtape/logtape';

/** Severity levels the CLI accepts; `warn` maps onto LogTape's `warning`. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Console rendering: pretty for terminals, JSON lines for pipes. */
export type ConsoleFormat = 'pretty' | 'json';

// The category is the activation tree: `aivi` is a one-shot CLI command,
// `aivi·host` is the serve application, and whatever the host starts hangs
// below it (`aivi·host·discord`). One color per module; the longest prefix
// wins, so a module's engine and turn records inherit its color. Knowledge
// hangs at root because the CLI builds it before any host exists. Dreaming
// is pinned to the muted gray — the prefix rule would otherwise dye it host
// blue — and the CLI root reaches the same gray by fallback.
const CATEGORY_COLORS: NonNullable<PrettyFormatterOptions['categoryColorMap']> = new Map([
  [['aivi', 'host', 'discord'], '#a371f7'],
  [['aivi', 'host', 'slack'], '#36c5f0'],
  [['aivi', 'host', 'linear'], '#5e6ad2'],
  [['aivi', 'knowledge'], '#C69214'],
  [['aivi', 'host', 'scheduler'], '#c51162'],
  [['aivi', 'host'], '#3B82FF'],
  [['aivi', 'host', 'dreaming'], '#767676'],
]);

const LOG_LEVELS: Record<LogLevel, LogTapeLogLevel> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};

/** Error's human message, for logs and for the CLI's user-facing failures alike. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a stream is attached to a terminal; the auto format keys off stderr. */
export function isTty(stream: { isTTY?: boolean } | undefined): boolean {
  return Boolean(stream?.isTTY);
}

export type LoggingSetup = {
  /** Lowest severity for the `aivi` category tree. */
  level: LogLevel;
  /** Console rendering; `auto` is resolved by the caller from stderr's TTY. */
  format: ConsoleFormat;
  /** JSON-lines log file to append to (rotated; its directory is created). Omit to skip the file. */
  logFile?: string;
};

/**
 * Wire LogTape once per process: a mirror on stderr (pretty on a terminal,
 * JSON lines when piped) plus an always-on JSON-lines log file, and return
 * the disposer to call at shutdown. The log file keeps its JSON shape
 * whatever the console does, so `jq` never cares whether a human was watching.
 */
export async function configureLogging(options: LoggingSetup): Promise<() => Promise<void>> {
  const jsonLines = getJsonLinesFormatter({ properties: 'flatten' });
  const consoleFormatter =
    options.format === 'pretty'
      ? getPrettyFormatter({
          colors: isTty(process.stderr),
          properties: true,
          timestamp: 'time',
          categoryColorMap: CATEGORY_COLORS,
          categoryColor: '#767676', // the one muted color, ours rather than LogTape's slate
          categoryStyle: 'italic', // color, not dim: dim is what mutes the palette
          messageColor: null, // terminal's own foreground; body text is never dim-on-dim
          messageStyle: null,
        })
      : jsonLines;
  // A plain function sink, not the stream adapter: disposing a web-stream
  // adapter closes process.stderr itself, and a logging shutdown must not
  // take the terminal's stderr down with it. stderr line-buffers on its own.
  const sinks: Record<string, Sink> = {
    stderr: (record: LogRecord) => {
      process.stderr.write(`${consoleFormatter(record)}\n`);
    },
  };
  const sinkNames = ['stderr'];
  if (options.logFile) {
    mkdirSync(dirname(options.logFile), { recursive: true });
    sinks.file = getRotatingFileSink(options.logFile, {
      formatter: jsonLines,
      maxSize: 10 * 1024 * 1024,
      maxFiles: 5,
    });
    sinkNames.push('file');
  }
  await configure({
    sinks,
    filters: { atLeast: LOG_LEVELS[options.level] ?? 'info', metaOnly: 'error' },
    loggers: [
      { category: ['aivi'], sinks: sinkNames, filters: ['atLeast'] },
      { category: ['logtape', 'meta'], sinks: sinkNames, filters: ['metaOnly'] },
    ],
  });
  return dispose;
}
