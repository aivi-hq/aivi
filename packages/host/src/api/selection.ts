import type { KnowledgeKind } from '@aivi/core';
import { knowledgeKindSchema } from '@aivi/core';

/** The source selection a query string carries, in the shape `selectSources` takes. */
export interface Selection {
  projects?: string[];
  includeCore: boolean;
  kinds?: KnowledgeKind[];
}
export type ParsedSelection = { ok: true; value: Selection } | { ok: false; error: string };

/** The first query parameter this grammar does not know, if any. */
function unknownKey(params: URLSearchParams, extra: string[]): string | undefined {
  const allowed = new Set(['project', 'includeCore', 'coreOnly', 'kind', ...extra]);
  for (const key of params.keys()) if (!allowed.has(key)) return key;
  return undefined;
}

/** The first true/false flag carrying anything else, if any. */
function badFlag(params: URLSearchParams): string | undefined {
  for (const key of ['includeCore', 'coreOnly'])
    if (params.has(key) && !['true', 'false'].includes(params.get(key)!)) return key;
  return undefined;
}

/** The selection the parameters stand for, once every part is known good. */
const selectionOf = (
  params: URLSearchParams,
  coreOnly: boolean,
  projects: string[],
  kinds: KnowledgeKind[],
): Selection => ({
  ...(coreOnly ? { projects: [] } : projects.length ? { projects } : {}),
  includeCore: params.get('includeCore') !== 'false',
  ...(kinds.length ? { kinds } : {}),
});

/** Shared query-string grammar: `project` (repeatable), `includeCore`, `coreOnly`, `kind` (repeatable). */
export function parseSelection(params: URLSearchParams, extra: string[]): ParsedSelection {
  const unknown = unknownKey(params, extra);
  if (unknown !== undefined) return { ok: false, error: `Unknown parameter: ${unknown}` };
  const invalid = badFlag(params);
  if (invalid !== undefined) return { ok: false, error: `Invalid ${invalid}` };
  const coreOnly = params.get('coreOnly') === 'true';
  const projects = params.getAll('project');
  if (coreOnly && projects.length) return { ok: false, error: 'Choose projects or coreOnly' };
  const kinds: KnowledgeKind[] = [];
  for (const kind of params.getAll('kind')) {
    const parsed = knowledgeKindSchema.safeParse(kind);
    if (!parsed.success) return { ok: false, error: `Unknown kind: ${kind}` };
    kinds.push(parsed.data);
  }
  return { ok: true, value: selectionOf(params, coreOnly, projects, kinds) };
}
