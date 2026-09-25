import type { KnowledgeKind } from '@aivi/core';
import { knowledgeKindSchema } from '@aivi/core';

/** The source selection a query string carries, in the shape `selectSources` takes. */
export interface Selection {
  projects?: string[];
  includeCore: boolean;
  kinds?: KnowledgeKind[];
}
export type ParsedSelection = { ok: true; value: Selection } | { ok: false; error: string };

/** Shared query-string grammar: `project` (repeatable), `includeCore`, `coreOnly`, `kind` (repeatable). */
export function parseSelection(params: URLSearchParams, extra: string[]): ParsedSelection {
  const allowed = new Set(['project', 'includeCore', 'coreOnly', 'kind', ...extra]);
  for (const key of params.keys()) if (!allowed.has(key)) return { ok: false, error: `Unknown parameter: ${key}` };
  for (const key of ['includeCore', 'coreOnly']) {
    if (params.has(key) && !['true', 'false'].includes(params.get(key)!)) return { ok: false, error: `Invalid ${key}` };
  }
  const coreOnly = params.get('coreOnly') === 'true';
  const projects = params.getAll('project');
  if (coreOnly && projects.length) return { ok: false, error: 'Choose projects or coreOnly' };
  const kinds = params.getAll('kind');
  for (const kind of kinds)
    if (!knowledgeKindSchema.safeParse(kind).success) return { ok: false, error: `Unknown kind: ${kind}` };
  return {
    ok: true,
    value: {
      ...(coreOnly ? { projects: [] } : projects.length ? { projects } : {}),
      includeCore: params.get('includeCore') !== 'false',
      ...(kinds.length ? { kinds: kinds as KnowledgeKind[] } : {}),
    },
  };
}
