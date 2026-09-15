import { Cron } from 'croner';
import { ISO_INSTANT } from './config.ts';

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
  if (!ISO_INSTANT.test(trimmed))
    throw new Error(`Not a time: "${at}". Use ISO 8601 (2026-09-16T09:00:00+02:00) or a duration (30m, 2h, 1d)`);
  const due = Date.parse(trimmed);
  if (Number.isNaN(due)) throw new Error(`Not a time: "${at}"`);
  if (due <= now) throw new Error(`${trimmed} is in the past`);
  return due;
}
