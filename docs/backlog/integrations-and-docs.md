# Integrations and documentation roadmap

Status: collecting. Rule: only features 90% of installations will want.
Slack was built in 2026-09-15 as this page recommended; the research below
(2026-09-14, official docs) now serves the remaining candidates: Telegram,
email, WhatsApp and Signal.

## Communication channels (adapters)

Discord and Slack exist on one contract ([channels.md](../channels.md)). Next
candidates named by the owner: Telegram, Signal, WhatsApp, email (with aivi
getting its own mailbox); research brief in
[research-channels.md](research-channels.md). Open points carried over from
the channel work (2026-09-15):

- Signal and Telegram (no threads, DM-first) will test whether the
  thread-per-conversation model generalizes; expect a "conversation without
  threads" case. Slack's `sessions: "channel"` mode is the closest thing today.
- Dreaming's default `origins` is `["discord"]`; a Slack-only installation must
  list `slack` itself. A default of "every registered channel module" needs the
  task to see the module list.
- Module health (the `modules[]` in `GET /status`) is not yet shown in the
  channels' own `/status` replies or in any health report.

## Documentation

- A proper docs site (GitHub Pages) generated from `docs/`.
- `docs/install.md` as the newcomer path; keep README short.

## Research

Baseline for effort estimates is the Discord module (`packages/channel-discord`):
gateway websocket via discord.js, the shared `accessPolicySchema`
(`channels[{id, trigger, sessions}]`; senders are admitted by their link, not
by config), thread-per-conversation, durable inbox, typing keep-alive,
`splitReply`, the shared command table, and a `Destinations` entry for job
reports.

### Channels at a glance

| | Telegram | Email | WhatsApp | Signal |
| --- | --- | --- | --- | --- |
| Connection | `getUpdates` long-poll or webhook | IMAP IDLE (push) + SMTP | Webhook only; public HTTPS endpoint required | Unofficial `signal-cli` daemon (JSON-RPC) or its REST container |
| Account needed | Bot via @BotFather, free | Any mailbox (IMAP/SMTP; Gmail/M365 need OAuth2 or app password) | Meta developer account, Meta app, WhatsApp Business Account, dedicated business number, system-user token | A phone number (register, or link as secondary device); Java 25 runtime |
| DM / group / thread | Private chats; groups/supergroups; forum topics (`message_thread_id`); no threads in plain groups | Per-address; no groups; threads via `In-Reply-To`/`References` | 1:1 only in practice; groups via API are new and limited; no threads | 1:1 and groups; no threads, only quoted replies |
| Fits `access`? | Yes; forum topics ≈ threads, plain groups need `sessions: "channel"` | `dm.users` = allowed sender addresses; `channels` has no natural equivalent | `dm.users` = phone numbers; `channels` essentially unused | `dm.users` = numbers/ACIs; groups only as `sessions: "channel"` |
| Bot identity / mention | Bot user; privacy mode means groups deliver only commands, replies and @mentions unless disabled | The mailbox address is the identity; being addressed is the trigger | The business number; no mention concept | Just another phone number; mentions exist in groups |
| Length / formatting | 4,096 chars; `MarkdownV2`/HTML parse modes; Bot API 10.x adds rich messages and `sendMessageDraft` streaming | No practical limit; text + HTML alternative | 4,096 chars; WhatsApp-style `*bold*` `_italic_` only | No small hard limit; "styled" text mode for bold/italic/mono |
| Typing indicator | `sendChatAction` (≈5 s, repeat like Discord) | None | Typing indicator when marking a message read (≈25 s) | `sendTyping` in signal-cli / REST |
| Node SDK | None official; grammY / Telegraf are the maintained community SDKs | `imapflow` + `nodemailer` (same maintainer, MIT, Node 20+, types bundled) | Plain Graph API `fetch`; Meta's Node SDK is not maintained | None official; community `signal-rest-ts` |
| Effort vs Discord | **M** | **M–L** | **L** | **L** |

### Telegram

HTTPS Bot API; `getUpdates` long-polling needs no inbound port, which fits the
loopback-bound host. Updates are kept 24 h server-side, so a short outage is
backfilled (Discord is not). Bots cannot start a private chat until the user
has messaged them, which is a natural allow-list. In groups the default
privacy mode delivers only commands, replies to the bot and @mentions, matching
`trigger: "mention"`; `trigger: "any"` needs privacy mode disabled by
BotFather (the Discord "Message Content intent" equivalent). Forum-enabled
supergroups have topics addressed by `message_thread_id`; a bot can create
topics (`createForumTopic`) if it is an admin with the right, so
`sessions: "threads"` is possible there and impossible in plain groups.
Formatting is the biggest porting cost: `MarkdownV2` requires escaping and
rejects unbalanced entities, so replies should be sent as HTML or plain text.
Bot API 10.x (2026) adds rich messages, ephemeral messages and
`sendMessageDraft` for streaming partial replies; none is required for v1.
Source: https://core.telegram.org/bots/api.

### Email

Not chat: no groups, no presence, no length limit, a different trust model.
`imapflow` handles IDLE, CONDSTORE/QRESYNC and mailbox locking; `nodemailer`
sends over SMTP with DKIM/OAuth2; both are MIT, TypeScript-typed and
maintained by the Nodemailer team (their commercial EmailEngine sits on top).
Mapping: a conversation is a thread keyed by `Message-ID`/`References`, the
speaker is the `From` address, `dm.users` is the allowed-sender list, and
there is no meaningful `channels` entry. Two problems Discord does not have:
sender spoofing (require SPF/DKIM/DMARC pass from the provider's
`Authentication-Results` header on top of the allow-list) and content
extraction (quoted history, HTML, signatures; `mailparser` helps). Replies are
one message per turn, which removes the need for typing indicators and
splitting. Because the mailbox is a real address, aivi could also receive
forwarded material as knowledge input, which is why the owner wants it; that
is a separate feature from chat.
Sources: https://nodemailer.com, https://github.com/postalsys/imapflow.

### WhatsApp

Cloud API is webhook-only: Meta POSTs to a public HTTPS endpoint, retries for
up to seven days on non-200, and requires a Meta app, a WhatsApp Business
Account, a system-user token with `whatsapp_business_messaging`, and a business
phone number that cannot also be used in the consumer app. Free-form replies
are allowed only inside the 24-hour customer-service window opened by the
user's last message; outside it only pre-approved templates may be sent, which
rules out proactive job reports unless a template is approved. Users must
opt in. There is no thread model and group messaging via API is new and
restricted, so the adapter would effectively be DM-only. The public webhook
conflicts with the host's loopback default and would need a tunnel or reverse
proxy (see the remote-access hardening item in the README).
Sources: https://developers.facebook.com/docs/whatsapp/cloud-api/get-started,
https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/,
https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/.

### Signal

There is no official bot API. `signal-cli` is an unofficial Java client
(JRE 25, native libsignal) that registers a number or links as a secondary
device; it must be updated within roughly three months of each release or the
server may reject it, and it must `receive` regularly for the encryption
state to stay healthy. Daemon mode exposes JSON-RPC over stdio/TCP/socket;
`signal-cli-rest-api` wraps that in a container with a `json-rpc` mode and a
Swagger API. aivi would have to run and update a second process, and the
adapter speaks to a phone-number identity rather than a bot. Groups have no
threads, so each group is one shared conversation (`sessions: "channel"`).
Sources: https://github.com/AsamK/signal-cli,
https://github.com/bbernhard/signal-cli-rest-api.

### Ranking by share of installations that would want it

(Slack ranked first and was built in 2026-09-15.)

1. **Telegram**: cheapest bot API, mobile-first, no inbound port; good for
   solo and small-team installs. Effort M (formatting is the main work).
2. **Email**: universal, but a different interaction model and trust
   boundary; valuable mainly for "mail things to aivi". Effort M–L.
3. **WhatsApp**: huge consumer reach, but business onboarding, webhook
   exposure, the 24-hour window and no groups make it a poor fit. Effort L.
4. **Signal**: privacy niche, unofficial client with a maintenance treadmill.
   Effort L.

### Docs site options

| | VitePress | MkDocs Material | Starlight (Astro) | GitHub Pages Jekyll |
| --- | --- | --- | --- | --- |
| Effort | `npm add -D vitepress`, one `docs/.vitepress/config.ts`, sidebar listed by hand; official GitHub Actions workflow | `pip install mkdocs-material`, one `mkdocs.yml`; nav auto-generated from folders; `mkdocs gh-deploy` in Actions | `npm create astro -- --template starlight`; content must live in `src/content/docs/` (symlink or custom loader to keep `docs/`) | Enable Pages on `docs/`; no build step |
| Look | Clean default theme, dark mode | Polished, many components | Most polished, i18n, components | Minimal theme, dated |
| Search | Built-in local (MiniSearch) | Built-in offline search | Built-in Pagefind | None |
| `docs/` stays the source | Yes: `docs/` is the site root, `.vitepress/` lives inside it, `.md` links rewrite | Yes: `docs_dir` defaults to `docs/`, relative `.md` links rewrite | Only via symlink/loader | Yes, but relative `.md` links do not resolve to pages |
| Toolchain | Node (matches repo; pinned devDependency). 1.6 stable, 2.0 alpha | Python in CI only | Node, heaviest | Ruby on GitHub's side only |

Sources: https://vitepress.dev/guide/getting-started,
https://squidfunk.github.io/mkdocs-material/publishing-your-site/,
https://starlight.astro.build/getting-started/.

## Recommendation

**Channels.** Slack went first, as recommended, and mapped 1:1 as predicted.
Build Telegram next; do not build WhatsApp or Signal (neither clears the 90 %
bar and both add operational burden that is not aivi's). Treat email as a
later, separate "mailbox" adapter whose main job is ingesting mail into
knowledge, not chatting; it needs identity linking and a sender-authentication
rule first. The channel-agnostic parts live in the host
([channels](../channels.md)), so an adapter is only: platform events →
`AccessRoute` + enqueue, and send(text). A plugin framework is still not
wanted. Extend `accessPolicySchema` only where a platform forces it (Telegram
forum topics are already covered by `sessions`).

**Docs site.** Use VitePress 1.x, pinned as a devDependency, with
`docs/.vitepress/config.ts` inside `docs/` so the Markdown stays the single
source and the README keeps linking to `docs/*.md`. Reasons: same Node
toolchain and lockfile as the rest of the monorepo, built-in local search,
file-based routing over the existing folder, and a one-file GitHub Actions
deploy. The sidebar is written by hand, which is fine for a dozen pages and
keeps ordering deliberate. Keep `docs:build` out of `npm run check` to keep
the gate fast; run it in the Pages workflow. If a Python step in CI is
acceptable, MkDocs Material is the only option with less effort (auto nav),
but it adds a second toolchain for no functional gain. Skip Starlight (needs
`src/content/docs/`) and plain Jekyll (no search, broken `.md` links).
