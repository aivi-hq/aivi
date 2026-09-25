import { existsSync, type FSWatcher, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ServedTool } from '@aivi/core';
import { createHostClient } from '@aivi/host/client';
import { Plugin } from '@opencode/plugin';

const DEFAULT_HOST_URL = 'http://127.0.0.1:4100';

/**
 * The aivi home, which holds `<home>/soul.md` and `<home>/config.json`. The aivi
 * home is the OpenCode location, so the default needs no configuration;
 * `AIVI_HOME`, or the plugin's `soul` option (a file: its directory is the
 * home), say otherwise.
 */
function aiviHome(options: Record<string, unknown>, location: { directory?: string } | undefined): string | undefined {
  if (typeof options.soul === 'string' && options.soul) return dirname(resolve(options.soul));
  if (process.env.AIVI_HOME) return resolve(process.env.AIVI_HOME);
  return location?.directory;
}

/**
 * The persona name, read straight out of `<home>/config.json` rather than through
 * the host: the plugin is a guest in someone else's process and must state who
 * aivi is even while the operator is mid-edit on a config the host would
 * refuse. `''` when there is nothing to say.
 */
function personaName(home: string): string {
  let identity: { name?: unknown } | undefined;
  try {
    identity = (JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { identity?: typeof identity }).identity;
  } catch {
    return '';
  }
  return typeof identity?.name === 'string' ? identity.name.trim() : '';
}

/**
 * The client config `aivi setup` writes: `~/.config/aivi.json` (or
 * `XDG_CONFIG_HOME`, or the file `AIVI_CONFIG` names), holding where the host
 * answers and which person signs in. Read as just a file — the plugin imports
 * no CLI code, the same standalone rule the attribution plugin keeps.
 */
function clientConfig(): { url?: string; token?: string } {
  const path = process.env.AIVI_CONFIG
    ? resolve(process.env.AIVI_CONFIG)
    : resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'aivi.json');
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as { url?: unknown; person?: { token?: unknown } };
    return {
      ...(typeof file.url === 'string' && file.url ? { url: file.url } : {}),
      ...(typeof file.person?.token === 'string' && file.person.token ? { token: file.person.token } : {}),
    };
  } catch {
    return {};
  }
}

/** The aivi home of a server holds `config.json` next to `.env` and `app/`; a
 *  machine with only the client config is a client. */
function isServerHome(home: string): boolean {
  return existsSync(join(home, 'config.json'));
}

export default Plugin.define({
  id: 'aivi',
  async setup(ctx) {
    const home = aiviHome(ctx.options as Record<string, unknown>, ctx.location as { directory?: string } | undefined);
    const baseUrl = typeof ctx.options.url === 'string' ? ctx.options.url : (clientConfig()?.url ?? DEFAULT_HOST_URL);
    // A missing token must not prevent the plugin from loading: the host may run with
    // auth mode "none", and a clear per-call error beats silently losing every tool.
    // On a client machine the bearer comes from the client config `aivi setup`
    // writes — but never on the server home itself: host-originated sessions
    // (Discord, jobs) associate by their own identity, and the operator's
    // cached bearer would claim every one of them.
    const token = process.env.AIVI_TOKEN ?? (home && isServerHome(home) ? undefined : clientConfig()?.token);
    const client = createHostClient(baseUrl, { token });
    // Text only: OpenCode 2.0.3 rejects a structured `output` unless the tool declares an output schema
    // ("Tool result declared output without an output schema"); Code Mode parses the JSON text.
    const json = (value: unknown) => ({ content: JSON.stringify(value) });

    // No aivi tool is hardcoded here. Each capability's owner — the host, or
    // an optional module such as the browser — contributes a descriptor, and
    // this process registers exactly what `GET /tools` answered at load.
    // Host down at that instant: the plugin is a no-op beside
    // `aivi_connection`, which says so. Re-registering tools mid-process would
    // invalidate the prompt cache of every live session, so the recovery for
    // a host that came up later is an explicit OpenCode reload, not a
    // background rescan.
    let served: ServedTool[] = [];
    try {
      served = await client.listTools();
    } catch (error) {
      console.error(
        `aivi plugin: loaded no tools from ${baseUrl}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Reload OpenCode once the host is running to pick them up.',
      );
    }
    const registration = await ctx.tool.transform(editor => {
      editor.namespace({ name: 'aivi', description: 'aivi installation status and configured knowledge sources' });
      editor.namespace({ name: 'knowledge', description: 'Search authoritative company and project documents' });

      editor.add({
        name: 'connection',
        description:
          'Report the connection from this OpenCode process to the aivi host: whether it answers now, its version, and which aivi tools this process loaded at startup. Use when an aivi tool is missing or a call fails; the host answering now does not mean its tools were loaded in this process. Relay the answer plainly.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { namespace: 'aivi', codemode: true },
        execute: async () => {
          let reachable = false;
          let failure: string | undefined;
          try {
            await client.health();
            reachable = true;
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
          const version = reachable
            ? await client
                .status()
                .then(s => s.version)
                .catch(() => undefined)
            : undefined;
          return json({
            reachable,
            host: baseUrl,
            ...(version ? { version } : {}),
            ...(failure ? { error: failure } : {}),
            toolsLoaded: served.map(tool => tool.id),
            ...(reachable && served.length === 0
              ? {
                  note: 'The host answers now, but this OpenCode process loaded none of its tools; reload OpenCode to pick them up.',
                }
              : {}),
          });
        },
      });
      for (const tool of served) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          options: { namespace: tool.namespace, codemode: true },
          execute: async (input, context) =>
            json(
              await client.callTool(tool.id, {
                sessionId: context.sessionID,
                ...(context.messageID ? { messageId: context.messageID } : {}),
                input: input as Record<string, unknown>,
                timeoutMs: tool.timeoutMs,
              }),
            ),
        });
      }
    });

    // The soul: who aivi is, appended to **every** agent's prompt (aivi runs on
    // a dedicated machine, so every agent there is an aivi agent). The
    // registry replays this transform on every rebuild — reading soul.md and
    // the persona name fresh each time — so an agent-file edit can never wipe
    // it and no soul text is copied into agent files. Neither file sits inside
    // the `.opencode` roots OpenCode watches, so the plugin watches them here
    // and invalidates the registry on change; sessions continue, history is in
    // the store.
    const disposers: (() => unknown)[] = [() => registration.dispose()];
    if (home && typeof ctx.agent?.transform === 'function') {
      const soul = join(home, 'soul.md');
      const agentTransform = await ctx.agent.transform(editor => {
        let text: string;
        try {
          text = readFileSync(soul, 'utf8').trim();
        } catch {
          return; // no soul yet: nothing to say
        }
        // The name is config, so it is said from config and never repeated in
        // soul.md: one place to change what every agent is called.
        const who = personaName(home);
        text = [who ? `Your name is ${who}.` : '', text].filter(Boolean).join('\n\n');
        if (!text) return;
        for (const agent of editor.list()) {
          editor.update(agent.id as unknown as string, a => {
            a.system = a.system ? `${a.system}\n\n${text}` : text;
          });
        }
      });
      disposers.push(() => agentTransform.dispose());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watcher: FSWatcher | undefined;
      try {
        watcher = watch(home, (_event, filename) => {
          if (filename && filename !== 'soul.md' && filename !== 'config.json') return;
          clearTimeout(timer);
          timer = setTimeout(() => void ctx.agent.reload(), 100);
        });
        disposers.push(() => {
          clearTimeout(timer);
          watcher?.close();
        });
      } catch {
        // No directory to watch: the soul is simply absent until it exists.
      }
    }

    return () => {
      for (const off of disposers) void off();
    };
  },
});
