import type { Logger } from '@aivi/core';
import { toolCallSchema } from '@aivi/core';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ToolError, type ToolRegistry } from '../../tools.ts';
import type { AppEnv } from '../env.ts';
import { capBody, MAX_JOB_BODY, requireJson, respond, zBody } from '../http.ts';

/**
 * The tool door: GET is the plugin's load-time read (descriptors only, no
 * handler crosses the wire), POST dispatches a call. A host without a
 * registry serves an empty list, not a failure.
 */
export function registerTools(app: Hono<AppEnv>, deps: { tools?: ToolRegistry | undefined; log: Logger }): void {
  const { tools, log } = deps;
  app.get('/tools', c => c.json({ tools: tools?.list() ?? [] }));
  app.post(
    '/tools',
    requireJson,
    capBody(MAX_JOB_BODY, 'Tool call is too large'),
    zBody('tool call', toolCallSchema),
    async c => {
      const call = c.req.valid('json');
      const claim = tools?.get(call.tool);
      if (!claim) return respond({ error: `No tool "${call.tool}" is offered by this host` }, 404);
      const invocation = {
        sessionId: call.sessionId,
        ...(call.messageId ? { messageId: call.messageId } : {}),
        input: call.input,
      };
      try {
        return c.json(await claim.handler(invocation));
      } catch (error) {
        if (error instanceof ToolError) return respond({ error: error.message }, error.status as ContentfulStatusCode);
        log.warn('tools.failed', { tool: call.tool, error });
        return respond({ error: 'The tool failed on the host; check its log.' }, 500);
      }
    },
  );
}
