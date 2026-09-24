/**
 * The browser as a composed module. It claims the `aivi_browser` tool at its
 * own door on `services.tools` — the host serves the claim to the OpenCode
 * plugin like any other tool and knows nothing browser-specific — and Chrome
 * with its MCP child start lazily on the first operation, so composing the
 * module costs nothing until someone acts. Stopping releases the tool (the
 * plugin's next load will not see it) and closes the MCP child; attached
 * Chrome and owned tabs stay for inspection.
 */
import type { BrowserConfig, ToolDescriptor } from '@aivi/core';
import { browserRequestSchema } from '@aivi/core';
import type { HostModule } from '@aivi/host';
import { ToolError } from '@aivi/host';
import { createBrowserService } from './index.ts';
import type { BrowserTransport } from './transport.ts';

/** The model-facing input; the handler validates the exact shape with zod. */
const browserInput = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['tabs', 'open', 'navigate', 'snapshot', 'click', 'fill', 'press', 'dialog', 'focus', 'close'],
    },
    tabId: {
      type: 'string',
      description: 'Tab owned by this session (from open/tabs). Required for every action except tabs/open.',
    },
    url: { type: 'string', description: 'HTTP(S) URL for open/navigate.' },
    uid: { type: 'string', description: 'The `id` of a node in the latest snapshot, for click/fill.' },
    value: { type: 'string', maxLength: 10000, description: 'Text for fill.' },
    key: { type: 'string', description: 'Key name for press.' },
    response: { type: 'string', enum: ['accept', 'dismiss'], description: 'Dialog response.' },
  },
} as const;

const descriptor: ToolDescriptor = {
  namespace: 'aivi',
  name: 'browser',
  description:
    'Control this session’s tabs in aivi’s own Chrome (not the OpenCode desktop browser). Start with open or tabs; snapshot returns nodes whose `id` is the uid for click/fill. Refresh snapshot after navigation. The shared profile retains logins; use focus for manual login. Never put passwords or secrets in fill. No automatic retries after uncertain actions.',
  input: browserInput,
  timeoutMs: 300_000,
};

export function createBrowserModule(config: BrowserConfig, transport?: BrowserTransport): HostModule {
  return {
    id: 'browser',
    async start(services) {
      const log = services.log.getChild('browser');
      const service = createBrowserService(config, transport);
      services.tools.claim(descriptor, async call => {
        const parsed = browserRequestSchema.safeParse(call.input);
        if (!parsed.success) throw new ToolError(400, 'Invalid browser request');
        try {
          return await service.execute(call.sessionId, parsed.data);
        } catch (error) {
          log.warn('browser.failed', { session: call.sessionId, action: parsed.data.action, error });
          throw new ToolError(
            409,
            'Browser operation failed. Inspect the owned tabs before retrying; uncertain connections require a host restart.',
          );
        }
      });
      return {
        async stop() {
          services.tools.release('aivi_browser');
          await service.close();
        },
      };
    },
  };
}
