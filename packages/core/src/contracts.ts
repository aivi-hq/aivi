import { z } from 'zod';
import type { Task, KnowledgeSource, Report } from './config.ts';
import { knowledgeKindSchema } from './config.ts';
import type { KnowledgeKind } from './kinds.ts';
import type { BrowserRequest, BrowserResult } from './browser.ts';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export interface Job {
  id: string; task: Task; resource: string; state: JobState; createdAt: number;
  scheduledFor: number; startedAt: number | null; finishedAt: number | null;
  scheduleId: string | null; sessionId: string | null; owner: string | null;
  result: unknown; error: string | null;
  report: Report | null;
}
export interface Status { version: string; counts: Record<JobState, number>; sources: number; leases: number; completion: 'verified-final-answer' }
export interface SourceSelection { projects?: string[]; includeCore?: boolean; kinds?: KnowledgeKind[] }
export interface SearchRequest extends SourceSelection { query: string; limit?: number }
/** Validation for search requests arriving over the API or from tools. */
export const searchSchema = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(20).default(8),
  projects: z.array(z.string().min(1)).max(100).optional(),
  includeCore: z.boolean().optional(),
  kinds: z.array(knowledgeKindSchema).min(1).optional(),
});
export interface SearchHit {
  sourceId: string; kind: KnowledgeKind; scope: 'core' | 'project'; projectId?: string;
  path: string; title: string; excerpt: string; line: number; score: number;
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
}
