/** The Meet module's operator commands, mounted through the `./cli`
 *  subpath contract: `aivi meet join|status|leave`.
 *
 *  The meeting belongs to serve — the voice brain (ASR, wake, sessions,
 *  TTS) lives in serve's seat, so the meeting must too. These commands are
 *  the request side: `join` files a one-off `meet.join` job and pokes the
 *  host, then follows the run to its end (the host's admission can take
 *  minutes — one bounded wait, the honest shape). `leave` files
 *  `meet.leave`. `status` reads the record serve writes. No daemon, no
 *  polling beyond bounded waits: the work lives in serve, this terminal
 *  only asks and watches. */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '@aivi/chrome';
import { jobSchema, type Run } from '@aivi/core';
import type { PluginCliContext } from '@aivi/plugin';
import { Command } from 'commander';
import { type MeetConfig, MODULE_ID, meetConfigSchema } from './config.ts';

interface MeetRecord {
  pid: number;
  url: string;
  phase: 'joining' | 'in-call';
  since: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readRecord(file: string): MeetRecord | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as MeetRecord;
    return typeof raw.pid === 'number' && typeof raw.url === 'string' ? raw : null;
  } catch {
    return null;
  }
}

/** The plugin block (its own defaults answer everything) plus core's
 *  resolved state directory, which is where the meeting record lives. */
async function meetContext(ctx: PluginCliContext): Promise<{ config: MeetConfig; stateDir: string }> {
  const loaded = await ctx.loaded();
  return {
    config: meetConfigSchema.parse(loaded.config.plugins[MODULE_ID] ?? {}),
    stateDir: loaded.config.stateDirectory,
  };
}

const DONE: Run['state'][] = ['succeeded', 'failed', 'missed', 'cancelled'];

/** File a one-off invocation job and follow its run to the end. Returns
 *  the finished run, or null when the watch ran out (the run keeps
 *  running; status still tells the truth). */
async function request(
  ctx: PluginCliContext,
  operation: string,
  args: Record<string, unknown>,
  watchMs: number,
): Promise<Run | null> {
  const now = Date.now();
  const jobId = await ctx.withStore(store => {
    const spec = jobSchema.parse({
      id: `job-meet-${randomUUID().slice(0, 8)}`,
      title: `meet ${operation}`,
      at: new Date(now).toISOString(),
      task: { kind: 'invocation', name: operation, args },
    });
    return store.addJob(spec, 'operator', now, { dedupeKey: `meet:${operation}:${randomUUID()}`, reason: 'meet' }).spec
      .id;
  });
  await ctx.poke();
  const deadline = Date.now() + watchMs;
  do {
    const run = await ctx.withStore(store => store.runs({ jobId, limit: 1 })[0]);
    if (run !== undefined && DONE.includes(run.state)) return run;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

export default (ctx: PluginCliContext): Command => {
  const meet = new Command('meet').description('join a Google Meet wearing the aivi face, ears and voice');

  meet
    .command('join <url>')
    .description('ask serve to join the meeting at the link (guest route, no Google account) and follow it in')
    .action(async (url: string) => {
      const { config, stateDir } = await meetContext(ctx);
      const record = join(stateDir, 'meet.json');
      const running = readRecord(record);
      if (running !== null && alive(running.pid))
        throw new Error(
          `aivi is already in a call (${running.phase}: ${running.url}, pid ${running.pid}) — aivi meet leave first`,
        );
      ctx.print(
        { requesting: url },
        'Requested the join. If Meet keeps a waiting room, the host must admit aivi — this terminal follows.',
      );
      const run = await request(ctx, 'meet.join', { url }, config.joinTimeoutMs + config.askTimeoutMs);
      if (run === null) {
        ctx.print(
          { joined: false, watching: false },
          'The join is still working (a waiting room may hold it) — `aivi meet status` follows, `aivi meet leave` gives up.',
        );
        return;
      }
      if (run.state !== 'succeeded') {
        ctx.print(
          { joined: false, state: run.state, reason: run.error },
          `The join did not make it: ${run.error ?? run.state}`,
        );
        return;
      }
      ctx.print(
        { joined: true, url, ...(run.result as object) },
        'In the call — face, ears and voice are live. `aivi meet leave` hangs up.',
      );
    });

  meet
    .command('status')
    .description('whether aivi is in a call right now, and which one')
    .action(async () => {
      const { stateDir } = await meetContext(ctx);
      const record = readRecord(join(stateDir, 'meet.json'));
      if (record === null) {
        ctx.print({ running: false }, 'Not in a call.');
        return;
      }
      if (!alive(record.pid)) {
        ctx.print(
          { running: false, stale: record },
          `Not in a call (the record of ${record.url} is stale — its process ${record.pid} is gone).`,
        );
        return;
      }
      ctx.print(
        { running: true, ...record },
        `${record.phase}: ${record.url} (pid ${record.pid}, since ${record.since})`,
      );
    });

  meet
    .command('leave')
    .description('hang up the call serve holds')
    .action(async () => {
      const { stateDir } = await meetContext(ctx);
      const record = readRecord(join(stateDir, 'meet.json'));
      if (record === null) {
        ctx.print({ left: false }, 'Not in a call.');
        return;
      }
      if (!alive(record.pid)) {
        await rm(join(stateDir, 'meet.json'), { force: true });
        ctx.print({ left: false, cleaned: true }, 'Not in a call; the stale record is cleaned.');
        return;
      }
      const run = await request(ctx, 'meet.leave', {}, 60_000);
      if (run === null || run.state !== 'succeeded') {
        ctx.print(
          { left: false, state: run?.state ?? 'watching' },
          `The leave did not confirm (${run?.error ?? 'still running'}); check \`aivi meet status\`.`,
        );
        return;
      }
      if (existsSync(join(stateDir, 'meet.json'))) await rm(join(stateDir, 'meet.json'), { force: true });
      ctx.print({ left: true }, `Hung up ${record.url}.`);
    });

  return meet;
};
