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
