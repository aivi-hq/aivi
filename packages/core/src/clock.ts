import { Cron } from 'croner';

/** An ISO 8601 instant; `Date.parse` alone accepts too much. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function nextOccurrence(pattern: string, timezone: string, after: number): number {
  const cron = new Cron(pattern, { timezone, paused: true });
  try {
    const next = cron.nextRun(new Date(after));
    if (!next) throw new Error(`Job has no future occurrence: ${pattern}`);
    return next.getTime();
  } finally {
    cron.stop();
  }
}

/** The next `count` occurrences after `after`, for confirming a job in plain text. */
export function nextOccurrences(pattern: string, timezone: string, after: number, count = 3): number[] {
  const cron = new Cron(pattern, { timezone, paused: true });
  try {
    return cron.nextRuns(count, new Date(after)).map(d => d.getTime());
  } finally {
    cron.stop();
  }
}

/** `Sep 15, 2026, 9:00 AM` in the job's timezone, for people reading a list or a report. */
export function formatInstant(at: number, timezone: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(at);
}

const DURATION = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * A duration on its own terms — `--older-than 30d`, a dispatcher timeout
 * `1h 30m` — as milliseconds. Space-separated parts **sum** (ruled
 * 2026-10-02: "Make sure it does addition (split on space)"); natural
 * language is deliberately not accepted; the model translates before calling.
 */
export function parseDuration(at: string): number {
  const parts = at.trim().split(/\s+/).filter(Boolean);
  const bad = () =>
    new Error(`Not a duration: "${at}". Use counts with s, m, h or d, added by spaces (30m, 2h, 1h 30m)`);
  if (!parts.length) throw bad();
  let total = 0;
  for (const part of parts) {
    const unit = DURATION.exec(part);
    if (!unit) throw bad();
    total += Number(unit[1]) * UNIT_MS[unit[2]!.toLowerCase() as keyof typeof UNIT_MS];
  }
  return total;
}

/**
 * A one-off "run at": an ISO 8601 instant or a relative duration (`30m`, `2h`, `1d`).
 * Natural language is deliberately not accepted; the model translates before calling.
 */
export function parseDue(at: string, now: number): number {
  const trimmed = at.trim();
  if (DURATION.test(trimmed)) {
    const due = now + parseDuration(trimmed);
    if (due <= now) throw new Error('A relative time must be in the future');
    return due;
  }
  // Date.parse accepts too much (e.g. "1"); insist on an ISO-looking value.
  if (!ISO_INSTANT.test(trimmed))
    throw new Error(`Not a time: "${at}". Use ISO 8601 (2026-09-16T09:00:00+02:00) or a duration (30m, 2h, 1d)`);
  const due = Date.parse(trimmed);
  if (Number.isNaN(due)) throw new Error(`Not a time: "${at}"`);
  if (due <= now) throw new Error(`${trimmed} is in the past`);
  return due;
}
