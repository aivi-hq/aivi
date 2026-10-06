// Follow the OpenCode event stream live, one line per event. The host never
// logs individual events (only connect/disconnect), and the stream is
// live-only, so this is the way to watch a turn: which event really ends one,
// what a permission prompt looks like on the wire, what a form does.
//
//   node scripts/follow-events.mjs                     # every event, every session
//   node scripts/follow-events.mjs ses_…               # one session (bare id works)
//   node scripts/follow-events.mjs --grep tool         # types containing a word
//   node scripts/follow-events.mjs --help
//
// Ctrl-C to stop. Run while the service is up (the one `aivi serve` uses).
import { parseArgs } from 'node:util';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const HELP = `follow-events — watch the OpenCode event stream live

  node scripts/follow-events.mjs [ses_…] [--grep WORD]

  ses_…        follow only this session (a bare id works; no --session needed)
  --grep WORD  show only event types containing WORD (e.g. tool, permission)
  --help       this text

Without a session id, every event on every session is shown. The five most
recent aivi-owned sessions are listed first, so picking one is a copy-paste.
Ctrl-C to stop.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { session: { type: 'string' }, grep: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
const session = values.session ?? positionals[0];
if (positionals.length > 1 || (values.session && positionals[0])) {
  console.error(`Unexpected arguments: ${positionals.join(' ')}\n\n${HELP}`);
  process.exit(1);
}
const endpoint = await Service.discover();
if (!endpoint) {
  console.error('No running OpenCode service.');
  process.exit(1);
}
const client = OpenCode.make({
  baseUrl: endpoint.url,
  headers: Service.headers({ url: endpoint.url, auth: endpoint.auth }),
});
// Sessions aivi owns: channel/job/dreaming turns carry metadata.aivi.origin;
// workers carry none and are known only by the id the dispatcher mints
// (ses_<service>_/ses_aivi_/ses_<channel>_ — the generators in session.ts,
// dispatcher.ts and channel/store.ts). Everything else is the operator's own.
const isAivi = s =>
  Boolean(s.metadata?.aivi) || /^ses_(aivi|orchestrator|scheduler|run|discord|slack|linear)_/.test(s.id);

// No session given: name the aivi-owned sessions first, so picking one is a copy-paste.
if (!session) {
  const all = (await client.session.list({ limit: 100 })).data ?? [];
  const owned = all.filter(isAivi).slice(0, 5);
  console.log(`aivi sessions (${owned.length} of ${all.length} listed, most recent first):`);
  if (!owned.length) console.log('  (none)');
  else for (const s of owned) console.log(`  ${s.id}  ${s.title ?? ''}`);
}
console.log(
  `following ${endpoint.url}${session ? ` session ${session}` : ''}${values.grep ? ` grep ${values.grep}` : ''} — Ctrl-C to stop`,
);
const abort = new AbortController();
process.on('SIGINT', () => abort.abort());
for await (const event of client.event.subscribe({ signal: abort.signal })) {
  const data = event.data ?? {};
  if (session && data.sessionID !== session) continue;
  if (values.grep && !event.type.includes(values.grep)) continue;
  const at = new Date().toISOString().slice(11, 23);
  const atSession = data.sessionID ? ` ${data.sessionID.slice(0, 17)}` : '';
  const detail = JSON.stringify(data).slice(0, 240);
  console.log(`${at} ${event.type}${atSession} ${detail}`);
}
