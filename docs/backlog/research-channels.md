# Research brief: the next chat channels for aivi

Paste everything below the line into a capable model without codebase access.
Results go into `docs/research/channels-<date>.md`; decisions into
[channel-adapters.md](channel-adapters.md).

---

## Who is asking

I maintain **aivi**, a small self-hosted "always-on teammate": one Node process
on a server that connects chat platforms to AI agents. Discord and Slack work
today. I want to add Telegram, Signal, WhatsApp and email next, and I need to
know, from **official primary sources only**, what each platform actually
allows a self-hosted bot to do. I cannot give you the code; the model below is
all you need.

## How aivi treats a chat platform (the contract every adapter fills)

A platform adapter is mostly glue around this shared behaviour:

1. **Access policy.** Config lists who may talk: DM allow-list of user ids, and
   shared channels/groups by id, each with an allowed-users list and a trigger
   (`mention`: every message must address the bot; `mention-to-start`: a
   mention opens a conversation, afterwards every message inside it counts;
   `any`). Unmatched messages are dropped before anything is stored.
2. **Conversations.** A conversation maps to one AI session with memory. In a
   shared channel a conversation is ideally a **thread** opened by the bot on
   the first message; where threads do not exist, the whole channel or the DM
   is one conversation. One turn at a time per conversation; extra messages
   queue in order.
3. **Signals while working.** People never wait in silence: a "waiting"
   marker when a message queues behind other work, a "working" marker while
   the agent thinks (Discord: typing indicator; Slack: an emoji reaction on
   the message), a short notice when something fails or after a restart.
4. **Replies.** Plain text, split to the platform's limit, posted into the
   conversation (thread/DM). No attachments yet.
5. **Commands.** Three small commands: start a fresh session, show status,
   search the knowledge base. Discord: slash commands registered via API;
   Slack: slash commands predefined in the app manifest with a prefix.
6. **Proactive posts.** Scheduled jobs may post an outcome into an allowed
   channel. The post should open a **thread bound to the job's session**, so a
   person replying there talks to the agent that produced it. A job outcome can
   also be delivered *into* an existing conversation as a turn.
7. **Identity.** Each message carries the platform's user id and display name
   so the agent knows who spoke.
8. **Hosting.** The bot runs on my server behind NAT. I strongly prefer
   **outbound-only connections** (long polling or WebSocket) over inbound
   webhooks that need a public URL and TLS. No third-party relay services.

## What I need for each of: Telegram, Signal, WhatsApp, email

Answer every point with a citation to official documentation (URL + the date
you read it). If something is not documented, say "not documented" rather than
guess. Where the official answer is "not possible", say so plainly.

1. **Bot account and API.** How a self-hosted bot gets an identity and
   credentials (bot token, linked device, phone number, mailbox). Costs,
   approval processes, business-account requirements, rate limits, and any
   terms-of-service constraints on automated accounts. For Signal: is there
   any official bot API at all, or only reverse-engineered/bridged clients
   (name them and state their status)? For WhatsApp: Cloud API vs. on-premises
   API vs. unofficial libraries; what "business verification" requires; what
   the 24-hour customer-service window means for a bot that posts on a
   schedule; template messages.
2. **Transport.** Long polling, WebSocket, or webhooks only? Can the bot run
   entirely outbound from behind NAT? What libraries do the platform's own
   docs recommend for Node.js, and are they maintained?
3. **Conversation model.** Do threads exist (Telegram forum topics; WhatsApp
   quoted replies; email threads via `In-Reply-To`/`References`)? Can the bot
   *create* one in response to a message? If not, what is the closest thing
   that lets several people share a channel without every message being one
   conversation? How does the bot address a reply to a specific message?
4. **Reading messages.** In a group, does the bot see all messages or only
   mentions/commands (Telegram "privacy mode")? What must the admin enable?
   Are edits, deletions and reactions delivered as events?
5. **Signals.** Typing indicators for bots (`sendChatAction`?), emoji
   reactions the bot can add and remove on a user's message, ephemeral
   messages, read receipts. Which of these exist per platform.
6. **Replies.** Message length limits, formatting (Markdown/HTML variants),
   link-preview control, mention syntax, how to reply into a thread.
7. **Commands.** Native command menus (Telegram `setMyCommands`), slash
   commands, or none. Can they be registered by API or only in a dashboard?
8. **Proactive messages.** Can the bot post without a preceding user message?
   To a group? To a DM? Any restrictions (WhatsApp templates and the 24-hour
   window; email obviously yes). Can it open a thread it then owns?
9. **Identity.** What user identifier is stable (Telegram user id, phone
   number, email address)? Display names? Are ids consistent across groups?
10. **Self-hosting realities.** For Signal and WhatsApp specifically: what a
    realistic self-hosted setup looks like today (a bridge process? a linked
    device? a dedicated number?), what breaks, and the risk of the account
    being banned. For email: IMAP IDLE vs. polling, SMTP sending, SPF/DKIM
    needs, and whether a normal mailbox (Fastmail, Google Workspace) suffices.

## Also, briefly

- Rank the four by **fit** with the model above and by **effort**, in one
  table with one sentence per cell.
- Name any platform I did not list that fits the model unusually well
  (Matrix? Microsoft Teams? Mattermost?) with two sentences of why.
- List the "conversation without threads" strategies you saw documented or
  widely used (reply-quoting, one session per DM, per-user sessions inside a
  group) with pros and cons, since Signal/WhatsApp/plain Telegram groups will
  need one.

## Output

A single Markdown document: one section per platform following the ten points,
then the ranking table, then the extras. Cite as you go. State the date. Do not
write code. Prefer official documentation; when you must use secondary
sources, mark them as such.
