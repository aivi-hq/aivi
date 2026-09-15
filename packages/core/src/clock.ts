import { Cron } from 'croner';

export function nextOccurrence(pattern: string, timezone: string, after: number): number {
  const cron = new Cron(pattern, { timezone, paused: true });
  try {
    const next = cron.nextRun(new Date(after));
    if (!next) throw new Error(`Schedule has no future occurrence: ${pattern}`);
    return next.getTime();
  } finally {
    cron.stop();
  }
}

/** The next `count` occurrences after `after`, for confirming a schedule in plain text. */
export function nextOccurrences(pattern: string, timezone: string, after: number, count = 3): number[] {
  const cron = new Cron(pattern, { timezone, paused: true });
  try {
    return cron.nextRuns(count, new Date(after)).map(d => d.getTime());
  } finally {
    cron.stop();
  }
}

const DURATION = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * A one-off "run at": an ISO 8601 instant or a relative duration (`30m`, `2h`, `1d`).
 * Natural language is deliberately not accepted; the model translates before calling.
 */
export function parseDue(at: string, now: number): number {
  const trimmed = at.trim();
  const relative = DURATION.exec(trimmed);
  if (relative) {
    const due = now + Number(relative[1]) * UNIT_MS[relative[2]!.toLowerCase() as keyof typeof UNIT_MS];
    if (due <= now) throw new Error('A relative time must be in the future');
    return due;
  }
  // Date.parse accepts too much (e.g. "1"); insist on an ISO-looking value.
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed))
    throw new Error(`Not a time: "${at}". Use ISO 8601 (2026-09-16T09:00:00+02:00) or a duration (30m, 2h, 1d)`);
  const due = Date.parse(trimmed);
  if (Number.isNaN(due)) throw new Error(`Not a time: "${at}"`);
  if (due <= now) throw new Error(`${trimmed} is in the past`);
  return due;
}
