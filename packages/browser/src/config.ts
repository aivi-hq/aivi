/** The browser plugin's wire vocabulary and registry declaration, at its
 *  `./config` subpath: the block's schema, the tool-call schemas the module
 *  validates with, and the lazy bridge to the module code. */
import { absolutePath } from '@aivi/core';
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

const profile = z.string().min(1);
const loopback = z.url().refine(value => {
  const u = new URL(value);
  return (
    u.protocol === 'http:' &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) &&
    !u.username &&
    !u.password &&
    u.pathname === '/' &&
    !u.search &&
    !u.hash
  );
}, 'Use a loopback Chrome debugging URL without credentials');
/**
 * The browser module: one persistent Chrome for unattended work. Its block lives at
 * `plugins.browser` in config.json; the `aivi-plugins` list in app/package.json says
 * whether the module runs. It claims its own `aivi_browser` tool at start.
 */
export const browserConfigSchema = z.strictObject({
  connection: z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('launch'),
      userDataDir: profile,
      executablePath: profile.optional(),
      headless: z.boolean().default(false),
    }),
    z.strictObject({ mode: z.literal('existing'), userDataDir: profile }),
    z.strictObject({ mode: z.literal('attach'), browserUrl: loopback }),
  ]),
  maxTabsPerSession: z.number().int().min(1).max(50).default(5),
  maxTabs: z.number().int().min(1).max(100).default(20),
  maxPending: z.number().int().min(1).max(100).default(16),
  timeoutMs: z.number().int().min(1000).max(60000).default(30000),
});
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
const tabId = z.string().uuid();
const uid = z.string().min(1).max(200);
const url = z.url().refine(value => {
  const u = new URL(value);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
}, 'Use HTTP(S) without embedded credentials');
export const browserRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('tabs') }),
  z.strictObject({ action: z.literal('open'), url }),
  z.strictObject({ action: z.literal('navigate'), tabId, url }),
  z.strictObject({ action: z.literal('snapshot'), tabId }),
  z.strictObject({ action: z.literal('click'), tabId, uid }),
  z.strictObject({ action: z.literal('fill'), tabId, uid, value: z.string().max(10000) }),
  z.strictObject({ action: z.literal('press'), tabId, key: z.string().min(1).max(100) }),
  z.strictObject({ action: z.literal('dialog'), tabId, response: z.enum(['accept', 'dismiss']) }),
  z.strictObject({ action: z.literal('focus'), tabId }),
  z.strictObject({ action: z.literal('close'), tabId }),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export const browserEnvelopeSchema = z.strictObject({
  sessionId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9_-]+$/),
  request: browserRequestSchema,
});
export interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
}
export interface BrowserResult {
  tabs?: BrowserTab[];
  tab?: BrowserTab;
  snapshot?: unknown;
  completed?: boolean;
}
export interface BrowserService {
  execute(sessionId: string, request: BrowserRequest): Promise<BrowserResult>;
  close(): Promise<void>;
}

/** The registry entry: paths in the connection (profile directories, the executable)
 *  are written relative to the home and resolved here; the module code — and with it
 *  any browser machinery — loads lazily. */
export const plugin: AiviPlugin<BrowserConfig> = {
  id: 'browser',
  configSchema: browserConfigSchema,
  createModule: (config, home) => {
    const connection = config.connection;
    const resolved =
      connection.mode === 'attach'
        ? config
        : {
            ...config,
            connection: {
              ...connection,
              userDataDir: absolutePath(home, connection.userDataDir),
              ...(connection.mode === 'launch' && connection.executablePath
                ? { executablePath: absolutePath(home, connection.executablePath) }
                : {}),
            },
          };
    // The lazy load is the design: the CLI reads this file's schema without
    // pulling the host's world in, and the module arrives only when the host
    // actually builds. The cycle back into this file (the module imports its
    // own schema) is that design, not a tangle.
    // fallow-ignore-next-line circular-dependency
    return import('./module.ts').then(m => m.createBrowserModule(resolved));
  },
};
