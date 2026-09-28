/** The server boot: what actually runs the host. The command surface
 *  (`@aivi/host/cli`) is what the host *provides* for `@aivi/cli` to collect;
 *  this file is what gets *run* — by launchd/systemd directly, and by the
 *  `serve` command in-process. There is no commander here: a boot has nothing
 *  to parse. Run this file directly and it boots once, with the logging a
 *  supervised process wants (JSON lines to the log file whatever the console
 *  does); imported, it exports the boot and does nothing. */
import { resolve } from 'node:path';
import type { LoadedConfig, Logger } from '@aivi/core';
import { configureLogging, isTty } from '@aivi/core';
import { createKnowledgeService } from '@aivi/knowledge';
import { type AiviModule, type HostResources, runHost } from './application.ts';
import { context, home, withStore } from './cli/context.ts';
import { buildModules } from './cli/registry.ts';

/** Foreground serve, from any entry that reached it: same home, same
 *  graceful stop. The `serve` command calls this after its own tree has
 *  configured logging; the direct entry below does the same for a process
 *  nobody parsed argv for. */
export async function startServer(): Promise<void> {
  const { loaded, registry, protectedEnv, log } = await context();
  // The `aivi-plugins` list in app/package.json says which modules run; the
  // config block is configuration only. Packages were read at context load
  // (their ./config declarations); the module code itself loads here.
  const modules: AiviModule[] = await buildModules(registry, loaded, home);
  const abort = new AbortController();
  // Stop means stop, and the operator sees it: the drains after this can
  // take seconds (idle keep-alive sockets expire on their own), so silence
  // here reads as a hung terminal. Measured on the dev home 2026-09-28:
  // the first Ctrl+C looked stuck for ~5 s.
  const stop = () => {
    log.info('host.stopping', {
      hint: 'shutting down gracefully — modules stop, in-flight work drains; a second Ctrl+C ends now',
    });
    abort.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await withStore(loaded, async store => {
    try {
      await runHost({
        loaded,
        store,
        modules,
        protectedEnv,
        log,
        signal: abort.signal,
        resources: () => createResources(loaded, log),
        onReady: address => {
          const ready = {
            listening: address,
            modules: modules.map(m => m.id),
            sources: loaded.sources.length,
          };
          // The record lands in the log stream and file whatever the console.
          log.info('host.listening', ready);
          // The raw JSON line is the machine-readable contract, for whoever
          // pipes stdout (scripts, smoke, supervisors). A human on a terminal
          // gets the pretty host.listening log record instead of a JSON blob.
          if (!isTty(process.stdout)) console.log(JSON.stringify(ready));
        },
      });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  });
}

async function createResources(loaded: LoadedConfig, log: Logger): Promise<HostResources> {
  // Knowledge logs under its own category: the service is built here, before
  // any host exists, and keeps this logger whatever job triggers an index.
  const knowledge = await createKnowledgeService(loaded, undefined, log.getChild('knowledge'));
  return { knowledge };
}

// launchd and systemd point their unit at this file: no bin, no argv, no
// parse. The logging is the `serve` command's shape — the same the preAction
// hook gives the mounted path — and the process lives until the stop signal
// drains it.
if (import.meta.main) {
  const closeLogging = await configureLogging({
    level: 'info',
    format: isTty(process.stderr) ? 'pretty' : 'json',
    logFile: resolve(home, 'state', 'logs', 'aivi.log'),
  });
  startServer()
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeLogging());
}
