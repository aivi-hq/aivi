/** The probe machinery both installers share: the health gate with its choice,
 *  and the diary waits. The installer is a second process; it proves a webhook
 *  by watching what the **live aivi** records in its request diary — so a live
 *  aivi is needed for the waits, and the waits are what the choice is about:
 *
 *  ```
 *  ● I started the server. Retry
 *  ○ Continue anyway — do not verify the webhook
 *  ```
 *
 *  Continuing writes everything and says UNVERIFIED: the unverified fact is
 *  precisely “GitHub can reach this machine”, and it is said that way, never
 *  as a claimed success. Every delivery is verified with the module's own seal
 *  check before it counts: GitHub signs the raw bytes, and the diary stores
 *  what arrived. A delivery that fails the check ends the wait at once — the
 *  secret would be wrong for every delivery, so waiting cannot help.
 */
import { hostUrl } from '@aivi/core';
import { verifyWebhookSignature } from '@aivi/github';
import type { PluginSetupContext, Store } from '@aivi/plugin';

/** How long the diary is watched when a check cannot pass: silence is a
 *  result too, and only a waited-out silence proves it. Tests shorten the
 *  window (AIVI_PROBE_WINDOW_MS, shared with the Linear installer); people
 *  get the honest cap. */
const DEFAULT_WINDOW_MS = 90_000;
export const probeWindowMs = (): number => Number(process.env.AIVI_PROBE_WINDOW_MS ?? DEFAULT_WINDOW_MS);

/** The installer is a second process and file events do not report SQLite's WAL
 *  writes (macOS never mentions them, measured 2026-09-26), so the diary is
 *  re-read on this quiet interval — one query on an indexed column. */
const POLL_MS = 2_000;

/** The events GitHub posts when a person installs the app or approves its
 *  grant — the `aivi add` probe's signal, and the natural one: the person is
 *  doing that act right now. */
export const INSTALLATION_EVENTS = new Set(['installation', 'installation_repositories']);

/** One payload as the live line says it, in GitHub's own words, naming the
 *  ticket it is about — during a test several issues can be in play. The
 *  status our side answered with is left out on purpose: with the module not
 *  yet loaded nothing can answer 2xx, and the delivery arriving is the point. */
export const describeDelivery = (event: string, payload: any): string => {
  const number = payload?.issue?.number ?? payload?.number;
  const at =
    payload?.repository?.full_name && number !== undefined
      ? `${payload.repository.full_name}#${number}`
      : 'something the payload did not name';
  const action = typeof payload?.action === 'string' ? ` ${payload.action}` : '';
  return `${event}${action} on ${at}`;
};

/** Whether the live aivi answers its health endpoint — the same test Linear's
 *  installer and the CLI make: `GET /health` on the **listen** URL, whatever
 *  its version. A raw-read config.json can lack the schema defaults, so the
 *  defaults are filled here: bind 127.0.0.1, port 4100. Pure of prompts, and
 *  `up` is re-asked on every retry. */
export async function hostIsUp(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  host: { bind?: string | undefined; port?: number | undefined } | undefined,
): Promise<boolean> {
  const listen = hostUrl({ bind: host?.bind ?? '127.0.0.1', port: host?.port ?? 4100 });
  return fetch(`${listen}/health`, { signal: AbortSignal.timeout(2_000) })
    .then(response => response.ok)
    .catch(() => false);
}

/** The health gate as a choice (ruled 2026-10-07): silence is not a stop, it
 *  is a fork. Retry re-asks; continue skips the waits and says so — the
 *  installer still writes its configuration, with UNVERIFIED in the summary. */
export async function gateHost(prompts: PluginSetupContext['prompts'], up: () => Promise<boolean>): Promise<boolean> {
  for (;;) {
    if (await up()) return true;
    const choice = await prompts.select({
      message: 'No live aivi answers its health endpoint — the probe watches what a running aivi records',
      options: [
        { value: 'retry', label: 'I started the server. Retry' },
        { value: 'skip', label: 'Continue anyway — do not verify the webhook' },
      ],
    });
    if (prompts.isCancel(choice)) throw new Error('the setup was cancelled at the health gate');
    if (choice === 'skip') {
      await prompts.log.message(
        'Continuing unverified: the configuration is written, but “GitHub can reach this aivi” stays unproved.',
      );
      return false;
    }
  }
}

/** The newest diary row id right now. Whatever exists before a test starts is
 *  nobody's business; anything the test draws lands with a larger id. */
export const latestId = (store: Store): number => {
  let last = 0;
  let rows = store.requests({ sinceId: last });
  while (rows.length) {
    last = rows[rows.length - 1]!.id;
    rows = store.requests({ sinceId: last });
  }
  return last;
};

/** What one wait saw in the diary. */
export interface Diaried {
  /** Verified deliveries this wait accepts — its proof. */
  mine: number;
  /** Verified deliveries about anything else: the URL and secret work; the
   *  events ticked on the webhook decide what arrives. */
  others: number;
  /** The diary cursor to hand to the next wait. */
  last: number;
}

/** The seal failure line — same words wherever the seal fails: the secret
 *  aivi holds is not the secret GitHub sends, and waiting on that changes
 *  nothing, so every wait ends at once. */
const badSeal = (row: { status: number }): Error =>
  new Error(
    `a delivery arrived but failed the module's own check: bad signature (HTTP ${row.status}).` +
      ' The secret this aivi holds is not the one GitHub sends — compare <home>/.env with the Secret on the app’s settings page.',
  );

const verifyRow = (secret: string, row: { body: string | null; headers: Record<string, string> }): boolean =>
  verifyWebhookSignature(secret, Buffer.from(row.body ?? '', 'utf8'), row.headers['x-hub-signature-256'] ?? '');

/** The seal check every wait runs on every row before anything else. A
 *  delivery that fails it ends the wait; the payload is the caller's to
 *  parse. */
function verifiedRow(
  secret: string,
  row: { body: string | null; headers: Record<string, string>; status: number },
): any {
  if (!verifyRow(secret, row)) throw badSeal(row);
  return JSON.parse(row.body ?? '{}');
}

/**
 * Watch the diary until one verified delivery `accepts` lands, `about` names
 * the thing under test, or `ms` has passed. A wait that passes is not made to
 * sit out its window; the window is what a failure needs. Every verified
 * delivery is said the moment it lands, whatever it names.
 */
export async function waitDiary(
  store: Store,
  watch: {
    path: string;
    secret: string;
    windowMs: number;
    accepts: (event: string, payload: any) => boolean;
    about: (event: string, payload: any) => boolean;
  },
  cursor: number,
  say: (line: string) => void,
): Promise<Diaried> {
  const { path, secret, windowMs, accepts, about } = watch;
  let mine = 0;
  let others = 0;
  let last = cursor;
  await new Promise<void>((settledPromise, failed) => {
    let done = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      // `aivi host clear-logs` can empty the diary and restart its ids below
      // our cursor; when that happens, follow the fresh diary, not the mark.
      if (latestId(store) < last) last = 0;
      for (const row of store.requests({ method: 'POST', path, sinceId: last })) {
        last = row.id;
        if (row.truncated)
          throw new Error(
            `a delivery arrived but the diary cut its body at 8 KiB (row ${row.id}) — verification needs the whole body.`,
          );
        const payload = verifiedRow(secret, row);
        const event = row.headers['x-github-event'] ?? '';
        say(`Heard: ${describeDelivery(event, payload)}`); // every delivery, the moment it lands
        if (!about(event, payload)) {
          others++;
          continue;
        }
        // The proof is in: a passed wait is nobody's waiting room, and the
        // stop's own read finishes nothing this loop has left to say.
        if (accepts(event, payload)) {
          mine++;
          stop();
          return;
        }
      }
    };
    const stop = (error?: Error): void => {
      if (done) return;
      done = true;
      if (poll !== undefined) clearTimeout(poll);
      if (expiry !== undefined) clearTimeout(expiry);
      if (error === undefined) {
        try {
          read(); // the deadline read: complete even if a tick was late
        } catch (cause) {
          failed(cause as Error);
          return;
        }
        settledPromise();
      } else failed(error);
    };
    const tick = (): void => {
      try {
        read();
      } catch (cause) {
        stop(cause as Error);
        return;
      }
      // Self-rescheduling: one pending timer, always, and a slow read
      // cannot pile up behind itself. And a read that ended the wait is
      // never re-armed: no timer outlives the verdict.
      if (done) return;
      poll = setTimeout(tick, POLL_MS);
    };
    poll = setTimeout(tick, POLL_MS); // the reliable arrival signal across processes: a re-read
    expiry = setTimeout(() => stop(), windowMs); // the window's end: a known instant
    try {
      read(); // whatever already arrived before the watching began
    } catch (cause) {
      stop(cause as Error);
    }
  });
  return { mine, others, last };
}

/** The board probe's five signals: the mutations the wizard pays, and what
 *  each one's delivery looks like. Names are verdict words; the wizard says
 *  which landed and which did not. */
export const BOARD_SIGNALS: Record<string, (event: string, payload: any) => boolean> = {
  'issue opened': (event, payload) => event === 'issues' && payload?.action === 'opened',
  'card added': (event, payload) => event === 'projects_v2_item' && payload?.action === 'created',
  'Status moved': (event, payload) =>
    event === 'projects_v2_item' &&
    payload?.action === 'edited' &&
    (payload?.changes?.field_name ?? payload?.changes?.field_value?.field_name) === 'Status',
  'Agent set': (event, payload) =>
    event === 'projects_v2_item' &&
    payload?.action === 'edited' &&
    (payload?.changes?.field_name ?? payload?.changes?.field_value?.field_name) === 'Agent',
  'comment posted': (event, payload) => event === 'issue_comment' && payload?.action === 'created',
};

/** Watch for the board probe's signals on one issue until all `asked` have
 *  landed or the window passes. Each landing is said the moment it arrives —
 *  the live line names what just came in. A signal already landed is never
 *  counted twice; the window is what a missing signal needs. */
export async function waitForSignals(
  store: Store,
  watch: {
    path: string;
    secret: string;
    windowMs: number;
    asked: string[];
    about: (event: string, payload: any) => boolean;
  },
  cursor: number,
  say: (line: string) => void,
): Promise<{ landed: Set<string>; last: number }> {
  const { path, secret, windowMs, asked, about } = watch;
  const landed = new Set<string>();
  let last = cursor;
  await new Promise<void>((settledPromise, failed) => {
    let done = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      if (latestId(store) < last) last = 0;
      for (const row of store.requests({ method: 'POST', path, sinceId: last })) {
        last = row.id;
        const payload = JSON.parse(row.body ?? '{}');
        const event = row.headers['x-github-event'] ?? '';
        if (!about(event, payload)) continue; // about another issue: this test is not about it
        if (row.truncated)
          throw new Error(
            `a delivery about the probe arrived but the diary cut its body at 8 KiB (row ${row.id}) — verification needs the whole body.`,
          );
        if (!verifyRow(secret, row)) throw badSeal(row);
        say(`Heard: ${describeDelivery(event, payload)}`);
        for (const name of asked) {
          if (!landed.has(name) && BOARD_SIGNALS[name]!(event, payload)) {
            landed.add(name);
            if (landed.size === asked.length) {
              stop();
              return;
            }
          }
        }
      }
    };
    const stop = (error?: Error): void => {
      if (done) return;
      done = true;
      if (poll !== undefined) clearTimeout(poll);
      if (expiry !== undefined) clearTimeout(expiry);
      if (error === undefined) {
        try {
          read();
        } catch (cause) {
          failed(cause as Error);
          return;
        }
        settledPromise();
      } else failed(error);
    };
    const tick = (): void => {
      try {
        read();
      } catch (cause) {
        stop(cause as Error);
        return;
      }
      if (done) return;
      poll = setTimeout(tick, POLL_MS);
    };
    poll = setTimeout(tick, POLL_MS);
    expiry = setTimeout(() => stop(), windowMs);
    try {
      read();
    } catch (cause) {
      stop(cause as Error);
    }
  });
  return { landed, last };
}

/** Whether a delivery is about the probe issue. `issue_comment` names it by
 *  `issue.number`; an `issues` delivery *is* the issue — its number sits at
 *  the payload's top; a `projects_v2_item` delivery names no number at all —
 *  only the content's node id — so the issue's own node id referees those. */
export const aboutIssue =
  (repoId: string, number: number, issueNodeId: string) =>
  (event: string, payload: any): boolean =>
    payload?.repository?.full_name === repoId &&
    (event === 'projects_v2_item'
      ? payload?.projects_v2_item?.content?.node_id === issueNodeId
      : (payload?.issue?.number ?? payload?.number) === number);

/** The board probe's verdict, pure: which signals landed, which did not, and
 *  what the missing one means. A signal never paid for (a board with one open
 *  Status option cannot show a move) is said as skipped, not as a failure. */
export function boardProbeVerdict(
  landed: Set<string>,
  asked: string[],
  windowMs: number,
): { pass: boolean; detail: string } {
  const missing = asked.filter(name => !landed.has(name));
  if (!missing.length)
    return { pass: true, detail: `all ${asked.length} deliveries arrived and verified — every seal matched` };
  const detail = `${missing.join(', ')} did not arrive in ${windowMs / 1000} s — the events ticked on the app decide what GitHub posts, and GitHub must reach this machine`;
  return { pass: false, detail };
}

/** The remedy line when the health gate's choice was made and the waits were
 *  skipped: named once, in the summary, in the same words both installers use. */
export const UNVERIFIED = 'UNVERIFIED — no live aivi watched, so “GitHub can reach this machine” was not proved';
