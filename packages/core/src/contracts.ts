import { z } from 'zod';
import type { BrowserRequest, BrowserResult } from './browser.ts';
import type { KnowledgeSource, Report, Task } from './config.ts';
import { knowledgeKindSchema } from './config.ts';
import type { KnowledgeKind } from './kinds.ts';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export interface Job {
  id: string;
  task: Task;
  resource: string;
  state: JobState;
  createdAt: number;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  scheduleId: string | null;
  sessionId: string | null;
  owner: string | null;
  result: unknown;
  error: string | null;
  report: Report | null;
}
export interface Status {
  version: string;
  counts: Record<JobState, number>;
  sources: number;
  leases: number;
  completion: 'verified-final-answer';
  /** The next few schedule occurrences, soonest first. */
  upcoming: { id: string; source: 'config' | 'agent'; kind: Task['kind']; nextAt: string }[];
  /** Jobs that reached a final state in the last 24 hours, newest first. */
  recent: {
    id: string;
    scheduleId: string | null;
    kind: Task['kind'];
    state: JobState;
    finishedAt: string;
    error: string | null;
  }[];
}

const identifier = z.string().min(1).max(200);
/**
 * What an agent may ask of the scheduler through `aivi_schedule`. The calling
 * session is the authority: the host reads its agent, directory and origin from
 * OpenCode and never trusts them from input.
 */
export const scheduleRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    sessionId: identifier,
    messageId: identifier.optional(),
    title: z.string().trim().min(1).max(80).optional(),
    prompt: z.string().trim().min(1).max(20_000).optional(),
    command: z.array(z.string().min(1)).min(1).max(64).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 3_600_000)
      .optional(),
    agent: z.string().min(1).optional(),
    directory: z.string().min(1).optional(),
    at: z.string().trim().min(1).optional(),
    cron: z.string().trim().min(1).optional(),
    timezone: z.string().min(1).optional(),
    report: z.enum(['session', 'channel', 'none']).default('session'),
    /** Channel module for `report: "channel"`; defaults to the module that owns the calling session. */
    module: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    on: z.enum(['always', 'failure']).default('always'),
  }),
  z.strictObject({ action: z.literal('list'), sessionId: identifier }),
  z.strictObject({ action: z.enum(['pause', 'resume', 'remove', 'run']), sessionId: identifier, id: identifier }),
]);
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;
export interface ScheduleItem {
  id: string;
  kind: 'schedule' | 'one-off';
  task: 'agent' | 'script';
  title: string;
  /** Cron + timezone for a schedule; the due instant for a one-off. */
  when: string;
  enabled: boolean;
  next: string[];
  lastRun: { state: JobState; at: string; error: string | null } | null;
  report: string;
}
export interface ScheduleResponse {
  /** One or two sentences the agent can relay as-is. */
  summary: string;
  items: ScheduleItem[];
}
export interface SourceSelection {
  projects?: string[];
  includeCore?: boolean;
  kinds?: KnowledgeKind[];
}
export interface SearchRequest extends SourceSelection {
  query: string;
  limit?: number;
}
/** Validation for search requests arriving over the API or from tools. */
export const searchSchema = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(8),
  projects: z.array(z.string().min(1)).max(100).optional(),
  includeCore: z.boolean().optional(),
  kinds: z.array(knowledgeKindSchema).min(1).optional(),
});
export interface SearchHit {
  sourceId: string;
  kind: KnowledgeKind;
  scope: 'core' | 'project';
  projectId?: string;
  path: string;
  title: string;
  excerpt: string;
  line: number;
  score: number;
}
export interface KnowledgeService {
  search(request: SearchRequest): Promise<SearchHit[]>;
  index(): Promise<unknown>;
  close(): Promise<void>;
}
export interface HostClient {
  browser(sessionId: string, request: BrowserRequest): Promise<BrowserResult>;
  status(): Promise<Status>;
  sources(selection?: SourceSelection): Promise<KnowledgeSource[]>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  schedule(request: ScheduleRequest): Promise<ScheduleResponse>;
  /** Ask the running host to dispatch now; used after the CLI changed the queue directly. */
  wake(): Promise<{ woken: boolean }>;
}
