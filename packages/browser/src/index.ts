export type { BrowserConfig, BrowserRequest, BrowserResult, BrowserService, BrowserTab } from './config.ts';
export { browserConfigSchema, browserEnvelopeSchema, browserRequestSchema, plugin } from './config.ts';
export { createBrowserModule } from './module.ts';
export { createBrowserService } from './service.ts';
export type { BrowserTransport, McpReply } from './transport.ts';
export { brandProfile, chromeArguments } from './transport.ts';
