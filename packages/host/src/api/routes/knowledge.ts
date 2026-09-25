import type { KnowledgeService, LoadedConfig, Logger } from '@aivi/core';
import { projectSummaries, searchSchema, selectSources } from '@aivi/core';
import type { Hono } from 'hono';
import type { AppEnv } from '../env.ts';
import { respond } from '../http.ts';
import { parseSelection } from '../selection.ts';

/**
 * `GET /knowledge/search` and `GET /sources`: the repeatable `project` and
 * `kind` parameters rule out a schema over the query string, so the handlers
 * parse the selection themselves and validate what remains.
 */
export function registerKnowledge(
  app: Hono<AppEnv>,
  deps: { loaded: LoadedConfig; knowledge?: KnowledgeService | undefined; log: Logger },
): void {
  app.get('/knowledge/search', async c => {
    const params = new URL(c.req.url).searchParams;
    const selection = parseSelection(params, ['q', 'limit']);
    if (!selection.ok) return respond({ error: selection.error }, 400);
    const parsed = searchSchema.safeParse({
      query: params.get('q'),
      ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      ...selection.value,
    });
    if (!parsed.success) return respond({ error: 'Invalid search request' }, 400);
    try {
      selectSources(deps.loaded, parsed.data.projects, parsed.data.includeCore, parsed.data.kinds);
    } catch (error) {
      return respond({ error: (error as Error).message }, 400);
    }
    const { knowledge } = deps;
    if (!knowledge) return respond({ error: 'Knowledge search is unavailable' }, 503);
    const { query, limit, projects, includeCore, kinds } = parsed.data;
    try {
      const hits = await knowledge.search({
        query,
        limit,
        ...(projects ? { projects } : {}),
        ...(includeCore !== undefined ? { includeCore } : {}),
        ...(kinds ? { kinds } : {}),
      });
      return c.json(hits);
    } catch (error) {
      deps.log.warn('knowledge.search.failed', { error });
      return respond({ error: 'Knowledge search is unavailable' }, 503);
    }
  });

  app.get('/sources', async c => {
    const selection = parseSelection(new URL(c.req.url).searchParams, []);
    if (!selection.ok) return respond({ error: selection.error }, 400);
    try {
      return c.json(
        selectSources(deps.loaded, selection.value.projects, selection.value.includeCore, selection.value.kinds),
      );
    } catch (error) {
      return respond({ error: (error as Error).message }, 400);
    }
  });

  app.get('/projects', c => c.json(projectSummaries(deps.loaded)));
}
