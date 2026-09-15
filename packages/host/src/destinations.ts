import type { Job, JobState, Report } from '@aivi/core';

export interface Destination {
  /** Deliver text to a channel of this destination. Throw if the channel is not enabled for aivi posts. */
  deliver(channel: string, text: string): Promise<void>;
}

/**
 * Modules register where job outcomes can go (Discord today; Slack, mail later).
 * The registry is deliberately tiny: a name → deliver function.
 */
export class Destinations {
  private readonly entries = new Map<string, Destination>();
  register(id: string, destination: Destination): () => void {
    if (this.entries.has(id)) throw new Error(`Destination ${id} is already registered`);
    this.entries.set(id, destination);
    return () => { this.entries.delete(id); };
  }
  has(id: string): boolean { return this.entries.has(id); }
  async deliver(report: Report, text: string): Promise<void> {
    const destination = this.entries.get(report.to);
    if (!destination) throw new Error(`No destination "${report.to}" is running`);
    await destination.deliver(report.channel, text);
  }
}

export function shouldReport(report: Report | null, state: JobState): report is Report {
  if (!report || report.on === 'never') return false;
  if (report.on === 'failure') return state === 'failed' || state === 'blocked';
  return true;
}

/** Human-readable outcome for chat channels; capped so a chatty tool cannot flood a channel. */
export function describeOutcome(job: Job, state: JobState, result: unknown, reason: string | undefined, limit = 1500): string {
  const label = job.scheduleId ? `schedule ${job.scheduleId}` : `job ${job.id.slice(0, 8)}`;
  const head = `${state === 'succeeded' ? '✅' : state === 'blocked' ? '⏸' : '❌'} ${label} (${job.task.kind}) ${state}`;
  let body: string;
  const r = result as Record<string, unknown> | null | undefined;
  if (job.task.kind === 'opencode.prompt' && typeof r?.text === 'string') body = r.text;
  else if (job.task.kind === 'dreaming' && r) {
    const reviewed = Number(r.reviewed ?? 0);
    const changed = Array.isArray(r.changed) ? r.changed as string[] : [];
    body = reviewed === 0
      ? 'No new conversations to review.'
      : [`Reviewed ${reviewed} conversation(s); ${changed.length ? `updated ${changed.join(', ')}` : 'memory unchanged'}.`, typeof r.text === 'string' ? r.text : ''].filter(Boolean).join('\n');
  }
  else if (job.task.kind === 'shell' && r) body = [`exit ${String(r.exitCode)}`, String(r.stdout ?? '').trim(), String(r.stderr ?? '').trim()].filter(Boolean).join('\n');
  else if (job.task.kind === 'system.check' && r && Array.isArray(r.sources)) {
    const missing = (r.sources as { id: string; available: boolean }[]).filter(s => !s.available).map(s => s.id);
    body = missing.length ? `Missing sources: ${missing.join(', ')}` : `All ${(r.sources as unknown[]).length} knowledge sources available.`;
  }
  else body = result === null || result === undefined ? '' : JSON.stringify(result);
  if (state !== 'succeeded' && reason) body = body ? `${reason}\n${body}` : reason;
  const text = body ? `${head}\n${body}` : head;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
