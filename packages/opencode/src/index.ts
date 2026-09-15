import type { BrowserRequest } from '@aivi/core';
import type { KnowledgeKind } from '@aivi/core/kinds';
import { knowledgeKindHelp, knowledgeKindNames } from '@aivi/core/kinds';
import { createHostClient } from '@aivi/host/client';
import { Plugin } from '@opencode/plugin';

const DEFAULT_HOST_URL = 'http://127.0.0.1:4100';

/**
 * Flat object schema for the browser tool. Provider tool APIs require a root
 * `object`; the host validates the exact per-action shape (`browserRequestSchema`).
 */
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

const selectionProperties = {
  projects: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Project IDs. Omit for all projects; [] for core only. Project knowledge is only relevant to that project unless the question compares projects.',
  },
  includeCore: { type: 'boolean', description: 'Include company-wide core sources (default true).' },
  kinds: {
    type: 'array',
    items: { type: 'string', enum: knowledgeKindNames },
    description: `Restrict to kinds of material. ${knowledgeKindHelp}`,
  },
} as const;

export default Plugin.define({
  id: 'aivi',
  async setup(ctx) {
    const baseUrl = typeof ctx.options.url === 'string' ? ctx.options.url : DEFAULT_HOST_URL;
    // A missing token must not prevent the plugin from loading: the host may run with
    // auth mode "none", and a clear per-call error beats silently losing every tool.
    const client = createHostClient(baseUrl, { token: process.env.AIVI_TOKEN });
    // Text only: OpenCode 2.0.3 rejects a structured `output` unless the tool declares an output schema
    // ("Tool result declared output without an output schema"); Code Mode parses the JSON text.
    const json = (value: unknown) => ({ content: JSON.stringify(value) });

    const registration = await ctx.tool.transform(editor => {
      editor.namespace({ name: 'aivi', description: 'aivi installation status and configured knowledge sources' });
      editor.namespace({ name: 'knowledge', description: 'Search authoritative company and project documents' });

      editor.add({
        name: 'search',
        description:
          'Keyword search over configured knowledge with source paths and excerpts. Omit projects for all; [] selects core only; includeCore defaults true.',
        input: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 2000 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
            ...selectionProperties,
          },
        },
        options: { namespace: 'knowledge', codemode: true },
        execute: async input =>
          json(
            await client.search(
              input as {
                query: string;
                projects?: string[];
                includeCore?: boolean;
                limit?: number;
                kinds?: KnowledgeKind[];
              },
            ),
          ),
      });
      editor.add({
        name: 'status',
        description: 'Inspect aivi job counts and capabilities. This does not start work.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { namespace: 'aivi', codemode: true },
        execute: async () => json(await client.status()),
      });
      editor.add({
        name: 'sources',
        description: 'List configured knowledge sources and their paths. Omit projects for all; [] for core only.',
        input: { type: 'object', properties: selectionProperties, additionalProperties: false },
        options: { namespace: 'aivi', codemode: true },
        execute: async input =>
          json(await client.sources(input as { projects?: string[]; includeCore?: boolean; kinds?: KnowledgeKind[] })),
      });
      editor.add({
        // Under `aivi`, not `browser`: OpenCode 2.0.3 has its own `browser.*` desktop tools and the model
        // conflated the two. The permission action is the tool id, `aivi_browser`, like the other aivi tools.
        name: 'browser',
        description:
          'Control this session’s tabs in aivi’s own Chrome (not the OpenCode desktop browser). Start with open or tabs; snapshot returns nodes whose `id` is the uid for click/fill. Refresh snapshot after navigation. The shared profile retains logins; use focus for manual login. Never put passwords or secrets in fill. No automatic retries after uncertain actions.',
        input: browserInput,
        options: { namespace: 'aivi', codemode: true },
        execute: async (input, context) => json(await client.browser(context.sessionID, input as BrowserRequest)),
      });
    });
    return () => registration.dispose();
  },
});
