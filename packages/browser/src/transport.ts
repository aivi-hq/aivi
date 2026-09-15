import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { BrowserConfig } from '@aivi/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpReply {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type?: string; text?: string }[];
}
export interface BrowserTransport {
  call(name: string, args: Record<string, unknown>): Promise<McpReply>;
  close(): Promise<void>;
}
export function chromeArguments(config: BrowserConfig): string[] {
  // Page lists arrive only as prose unless structured content is switched on (default off in 1.9.0's stdio mode).
  const args = [
    '--no-usage-statistics',
    '--no-performance-crux',
    '--pageIdRouting=true',
    '--experimentalStructuredContent=true',
  ];
  const connection = config.connection;
  if (connection.mode === 'attach') args.push(`--browserUrl=${connection.browserUrl}`);
  else {
    args.push(`--userDataDir=${connection.userDataDir}`);
    if (connection.mode === 'existing') args.push('--autoConnect');
    else {
      args.push(
        `--headless=${connection.headless}`,
        '--ignoreDefaultChromeArg=--disable-extensions',
        '--ignoreDefaultChromeArg=--disable-component-extensions-with-background-pages',
      );
      if (connection.executablePath) args.push(`--executablePath=${connection.executablePath}`);
    }
  }
  return args;
}

/**
 * Make aivi's own Chrome recognisable: an amber window titled "aivi", like OpenClaw's
 * orange one. Chrome has no launch flag for this, so the profile's Preferences are
 * seeded before the first start. Only unset values are written, so a colour chosen
 * later in that window is kept.
 */
export async function brandProfile(userDataDir: string): Promise<void> {
  const file = join(userDataDir, 'Default', 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  prefs.browser ??= {};
  const browser = prefs.browser as Record<string, unknown>;
  browser.theme ??= {};
  const theme = browser.theme as Record<string, unknown>;
  prefs.profile ??= {};
  const profile = prefs.profile as Record<string, unknown>;
  if (theme.user_color !== undefined && profile.name !== undefined) return;
  // ARGB 0xFFFFB300 (amber) as the signed 32-bit integer Chrome stores; variant 3 = vibrant.
  theme.user_color ??= 0xffffb300 - 0x100000000;
  theme.color_variant ??= 3;
  theme.follows_system_colors ??= false;
  profile.name ??= 'aivi';
  await writeFile(file, JSON.stringify(prefs));
}

/** One lazy stdio child per host, using the installed pinned package; never npx/latest. */
export function createChromeTransport(config: BrowserConfig): BrowserTransport {
  const desktopEnv: Record<string, string> = {};
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
    if (process.env[key]) desktopEnv[key] = process.env[key]!;
  }
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let connecting: Promise<Client> | undefined;
  let closed = false;
  async function connect(): Promise<Client> {
    if (closed) throw new Error('Browser transport is closed');
    if (client) return client;
    connecting ??= (async () => {
      if (config.connection.mode === 'launch') await brandProfile(config.connection.userDataDir);
      const require = createRequire(import.meta.url);
      const entry = resolve(dirname(require.resolve('chrome-devtools-mcp')), 'bin/chrome-devtools-mcp.js');
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry, ...chromeArguments(config)],
        env: {
          ...getDefaultEnvironment(),
          ...desktopEnv,
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        },
        stderr: 'pipe',
      });
      // Consume diagnostics without copying browser content or URLs into application logs.
      transport.stderr?.on('data', () => {});
      const candidate = new Client({ name: 'aivi-browser', version: '0.1.0' });
      try {
        await candidate.connect(transport, { timeout: config.timeoutMs });
        const { tools } = await candidate.listTools({}, { timeout: config.timeoutMs });
        for (const name of ['navigate_page', 'take_snapshot', 'click', 'fill', 'press_key', 'handle_dialog']) {
          const schema = tools.find(t => t.name === name)?.inputSchema;
          if (!schema?.required?.includes('pageId')) throw new Error(`Chrome MCP lacks required page routing: ${name}`);
        }
        client = candidate;
        return candidate;
      } catch (error) {
        await candidate.close();
        throw error;
      }
    })();
    return connecting;
  }
  return {
    async call(name, args) {
      const connection = await connect();
      return (await connection.callTool({ name, arguments: args }, undefined, {
        timeout: config.timeoutMs,
      })) as McpReply;
    },
    async close() {
      closed = true;
      try {
        await connecting;
      } catch {
        /* Failed startup still owns its transport. */
      }
      await client?.close();
      await transport?.close();
    },
  };
}
