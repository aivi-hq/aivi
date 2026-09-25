import { randomUUID } from 'node:crypto';
import type { BrowserConfig, BrowserRequest, BrowserResult, BrowserService, BrowserTab } from '@aivi/core';
import { browserEnvelopeSchema } from '@aivi/core';
import type { BrowserTransport, McpReply } from './transport.ts';
import { createChromeTransport } from './transport.ts';

type Page = { id: number; url: string; title: string; selected: boolean };
type Owned = { owner: string; pageId: number; tabId: string };
function pages(reply: McpReply): Page[] {
  const raw = reply.structuredContent?.pages;
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.some(
      p =>
        !p ||
        !Number.isSafeInteger(p.id) ||
        typeof p.url !== 'string' ||
        typeof p.title !== 'string' ||
        typeof p.selected !== 'boolean',
    )
  )
    throw new Error('Invalid Chrome MCP page response');
  return raw as Page[];
}

/** Tab ownership is coordination within one team profile, not cookie/identity isolation. */
export function createBrowserService(
  config: BrowserConfig,
  transport: BrowserTransport = createChromeTransport(config),
): BrowserService {
  const owned = new Map<string, Owned>();
  let tail = Promise.resolve();
  let pending = 0;
  let closed = false;
  let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  const fail = () =>
    (failure ??= new Error('Browser connection is uncertain; inspect Chrome and restart aivi before continuing'));
  async function call(name: string, args: Record<string, unknown>): Promise<McpReply> {
    let reply: McpReply;
    try {
      reply = await transport.call(name, args);
    } catch {
      throw fail();
    }
    if (reply.structuredContent?.reconnected) throw fail();
    if (reply.isError) {
      const detail = (reply.content ?? [])
        .map(c => c.text ?? '')
        .join('\n')
        .split('\n')
        .find(line => line.trim());
      throw new Error(
        `Browser action failed${detail ? `: ${detail.slice(0, 200)}` : ''}; inspect the tab before retrying`,
      );
    }
    return reply;
  }
  function tab(entry: Owned, current: Page[]): BrowserTab {
    const page = current.find(p => p.id === entry.pageId);
    if (!page) throw new Error('Tab is no longer open');
    return { tabId: entry.tabId, url: page.url, title: page.title };
  }
  /** Open a tab for `owner`: a blank page first, so a failed navigation must not lose its owner. */
  async function openTab(
    owner: string,
    request: Extract<BrowserRequest, { action: 'open' }>,
    current: Page[],
  ): Promise<BrowserResult> {
    if (
      owned.size >= config.maxTabs ||
      [...owned.values()].filter(t => t.owner === owner).length >= config.maxTabsPerSession
    )
      throw new Error('Browser tab limit reached');
    let created: Page[];
    try {
      created = pages(await call('new_page', { url: 'about:blank', timeout: config.timeoutMs }));
    } catch {
      throw fail();
    }
    const added = created.filter(p => !current.some(old => old.id === p.id));
    const page = added.find(p => p.selected && p.url === 'about:blank');
    if (!page || added.filter(p => p.selected).length !== 1) throw fail();
    const entry = { owner, pageId: page.id, tabId: randomUUID() };
    owned.set(entry.tabId, entry);
    await call('navigate_page', { pageId: page.id, type: 'url', url: request.url, timeout: config.timeoutMs });
    return { tab: tab(entry, pages(await call('list_pages', {}))) };
  }

  /** Forget the tab only once Chrome says it is gone; a stubborn tab stays owned. */
  async function closeTab(entry: Owned): Promise<BrowserResult> {
    const remaining = pages(await call('close_page', { pageId: entry.pageId }));
    if (remaining.some(p => p.id === entry.pageId)) throw new Error('Chrome did not close the tab; ownership retained');
    owned.delete(entry.tabId);
    return { completed: true };
  }

  /** The MCP call each page action maps to; the tab is already owned and checked. */
  function actionFor(request: Exclude<BrowserRequest, { action: 'tabs' | 'open' | 'close' }>, entry: Owned) {
    const args: Record<string, unknown> = { pageId: entry.pageId };
    let name: string;
    switch (request.action) {
      case 'snapshot':
        name = 'take_snapshot';
        break;
      case 'navigate':
        name = 'navigate_page';
        Object.assign(args, { type: 'url', url: request.url, timeout: config.timeoutMs });
        break;
      case 'click':
        name = 'click';
        args.uid = request.uid;
        break;
      case 'fill':
        name = 'fill';
        Object.assign(args, { uid: request.uid, value: request.value });
        break;
      case 'press':
        name = 'press_key';
        args.key = request.key;
        break;
      case 'focus':
        name = 'select_page';
        args.bringToFront = true;
        break;
      case 'dialog':
        name = 'handle_dialog';
        args.action = request.response;
        break;
    }
    return { name, args };
  }

  async function run(owner: string, request: BrowserRequest): Promise<BrowserResult> {
    if (failure) throw failure;
    // Upstream IDs are monotonic within a process, including browser reconnections.
    // Reconnection notices block this service; a new MCP process never reuses our map.
    const current = pages(await call('list_pages', {}));
    for (const [id, entry] of owned) if (!current.some(p => p.id === entry.pageId)) owned.delete(id);
    if (request.action === 'tabs')
      return { tabs: [...owned.values()].filter(t => t.owner === owner).map(t => tab(t, current)) };
    if (request.action === 'open') return openTab(owner, request, current);
    const entry = owned.get(request.tabId);
    if (!entry || entry.owner !== owner) throw new Error('Tab is not owned by this session');
    if (request.action === 'close') return closeTab(entry);
    const { name, args } = actionFor(request, entry);
    const reply = await call(name, args);
    if (request.action === 'snapshot') {
      const snapshot = reply.structuredContent?.snapshot;
      if (snapshot === undefined) throw new Error('Chrome MCP returned no snapshot');
      // Never forward the raw response, which can include other sessions' page lists.
      return { snapshot };
    }
    return { completed: true };
  }
  return {
    execute(sessionId, raw) {
      const parsed = browserEnvelopeSchema.parse({ sessionId, request: raw });
      if (closed) return Promise.reject(new Error('Browser service is closing'));
      if (pending >= config.maxPending) return Promise.reject(new Error('Browser queue is full'));
      pending++;
      const operation = tail.then(() => run(parsed.sessionId, parsed.request));
      tail = operation
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          pending--;
        });
      return operation;
    },
    close() {
      closed = true;
      // Stop the MCP child after in-flight calls. Attached Chrome stays open;
      // owned tabs remain inspectable. Closing tabs never implies undoing effects.
      closePromise ??= tail.then(() => transport.close());
      return closePromise;
    },
  };
}
