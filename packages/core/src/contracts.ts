import { z } from 'zod';
import type { BrowserRequest, BrowserResult } from './browser.ts';
import type { KnowledgeSource, Report, Task } from './config.ts';
import { knowledgeKindSchema } from './config.ts';
import type { KnowledgeKind } from './kinds.ts';

/**
 * One execution of a job. `missed` is terminal and never ran: the occurrence
 * was found later than its misfire grace (aivi was not running).
 */
export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'missed';
export interface Run {
  id: string;
  /** The definition this run belongs to; every run has one. */
  jobId: string;
  /** Snapshot of the job's task at materialization, so editing the definition never changes a queued run. */
  task: Task;
  resource: string;
  state: RunState;
  createdAt: number;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  sessionId: string | null;
  owner: string | null;
  result: unknown;
  error: string | null;
  report: Report | null;
}
/** Who defined a job: `aivi.json`, an agent through `aivi_jobs`, the operator CLI, or the host itself (retention). */
export type JobSource = 'config' | 'agent' | 'operator' | 'system';
/** A definition's own state; `done` and `missed` only happen to one-offs. */
export type JobState = 'active' | 'paused' | 'done' | 'missed';
/** One optional module as the host sees it; `degraded` means its start failed and is being retried. */
export interface ModuleHealth {
  id: string;
  state: 'starting' | 'running' | 'degraded' | 'stopped';
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
}
export interface Status {
  version: string;
  counts: Record<RunState, number>;
  sources: number;
  leases: number;
  completion: 'verified-final-answer';
  /** Optional modules and whether each is running; empty from the CLI, which has no running host. */
  modules: ModuleHealth[];
  /** The next few job occurrences, soonest first; `kind` is the task label: kind, or operation name for an invocation. */
  upcoming: { id: string; source: JobSource; kind: string; title: string | null; nextAt: string }[];
  /** Runs that reached a final state in the last 24 hours, newest first. */
  recent: {
    id: string;
    jobId: string;
    kind: string;
    state: RunState;
    finishedAt: string;
    error: string | null;
  }[];
}

const identifier = z.string().min(1).max(200);
/**
 * What an agent may ask of the scheduler through `aivi_jobs`. The calling
 * session is the authority: the host reads its agent, directory and origin from
 * OpenCode and never trusts them from input.
 */
export const jobRequestSchema = z.discriminatedUnion('action', [
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
    /** Platform channel for `report: "channel"`; defaults to the channel the calling conversation lives in. */
    channel: z.string().min(1).optional(),
    on: z.enum(['always', 'failure']).default('always'),
  }),
  z.strictObject({ action: z.literal('list'), sessionId: identifier }),
  z.strictObject({ action: z.enum(['pause', 'resume', 'remove', 'run']), sessionId: identifier, id: identifier }),
]);
export type JobRequest = z.infer<typeof jobRequestSchema>;
export interface JobItem {
  id: string;
  kind: 'recurring' | 'one-off';
  task: 'agent' | 'script';
  title: string;
  /** Cron + timezone for a recurring job; the due instant for a one-off. */
  when: string;
  state: JobState;
  next: string[];
  lastRun: { state: RunState; at: string; error: string | null } | null;
  report: string;
}
export interface JobResponse {
  /** One or two sentences the agent can relay as-is. */
  summary: string;
  items: JobItem[];
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
/** What the librarian sees of a project: enough to know it exists (or existed) and what can be searched. */
export interface ProjectSummary {
  id: string;
  /** The checkout is gone; only memory remains until purged. */
  removed?: true;
  sources: { id: string; kind: KnowledgeKind }[];
}
/** A human colleague aivi knows by name; aivi's own work is never a person. */
export interface Person {
  id: string;
  name: string;
  email: string | null;
  createdAt: number;
}
/**
 * A bearer credential that identifies one person for association (whose job,
 * whose link, whose memory). Only the hash is stored; the secret is shown
 * once at mint. A token never authorizes — it answers "which person is this".
 */
export interface PersonToken {
  hash: string;
  personId: string;
  label: string;
  createdAt: number;
}
/** Who the caller is: the one endpoint that cannot be served anonymously. */
export interface Whoami {
  person: { id: string; name: string };
  roles: string[];
}
export interface HostClient {
  browser(sessionId: string, request: BrowserRequest): Promise<BrowserResult>;
  status(): Promise<Status>;
  sources(selection?: SourceSelection): Promise<KnowledgeSource[]>;
  projects(): Promise<ProjectSummary[]>;
  /** Markdown describing an OpenCode session's context window, totals and knowledge scope. */
  context(sessionId: string): Promise<{ text: string }>;
  search(request: SearchRequest): Promise<SearchHit[]>;
  jobs(request: JobRequest): Promise<JobResponse>;
  /** The person the bearer names; the one endpoint a request cannot make anonymously. */
  whoami(): Promise<Whoami>;
  /** Ask the running host to dispatch now; used after the CLI changed the queue directly. */
  wake(): Promise<{ woken: boolean }>;
}
