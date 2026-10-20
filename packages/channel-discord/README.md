# @aivi/channel-discord

Discord channel module: gateway, DM/thread routing, sending, slash
commands, and report threads. It implements the host's `ChannelModule`
contract; the host owns the inbox, bindings, engine, and turn runner.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/channel-discord` | `createDiscordModule` — the module a running server composes |
| `./config` | the `plugin` declaration: module id and config schema |
| `./setup` | the setup guide `aivi add discord` runs |
| `./cli` | the `aivi discord` command |

## Enable it

The short way is `aivi add discord`: it prints how to create the
Discord app, asks for the tokens, verifies each, writes `config.json` and
`.env` itself, and aivi comes back with the module running.

By hand: list `@aivi/channel-discord` in `aivi-plugins` in
`app/package.json` — the list is what enables a module, the block is only
its setup — and write a validated `plugins.channel-discord` block in
`config.json`. Put `DISCORD_BOT_TOKEN` in `.env`. Slash commands are
registered at start.

The module id is `channel-discord`, the package's short name; the *platform*
id stays `discord` and is what keys the database tables and session ids,
because renaming a prefix would orphan every conversation already bound
to it.

## Hearing voice channels (`voice`)

With `voice: { guild, channels, silenceMs }` in the block, the bot joins
those voice channels on the **same gateway connection** (the
`GuildVoiceStates` intent joins the request when the block is present) and
hears every utterance. Discord **names and demuxes its speakers** (SSRC →
user id: a linked account speaks under its aivi person name, everyone else
under their Discord display name) and delivers a live Opus stream per user;
this package decodes every packet while the person is still talking and
pushes it into a `lane()` of the voice room — nothing is buffered into a
"finished clip" first. When an utterance *ends* is our rule, not the
platform's: `silenceMs` of quiet (AfterSilence) closes it. Transcription,
wake, transcripts and capacity are the voice plugin's, reached through the
kit's `Voice` seat. **Presence drives everything**: aivi joins a
configured channel when the first *linked person* enters it and leaves when
the last one is gone — no person in, nothing born: no connection, no room,
no transcript. The models are not the channel's to keep: engine warmth is
`@aivi/voice`'s job, so a rejoin is instant. What the room *does* with the
speech follows `voice.mode`: in `meeting` a transcript ends with the
meeting (`transcripts()` lists the occurrences); in `call` there is no
record — words go to the session, streamed back **while the person is still
speaking**, and **a linked person's first recognized word silences aivi
mid-answer** (a bare speaking start does not — a sniffle passes Discord's
VAD; strangers and bots cannot interrupt at all). **The voice plugin must
be loaded** (`aivi add @aivi/voice`): if it is not, the first arrival costs
one loud log line (`voice.not-loaded`) — text conversations carry on.
Absent the block, aivi never joins voice.

DAVE reality, verified 2026-10-11: Discord enforces E2EE on voice since
2026-03-01; `@discordjs/voice` 0.19.2 fixed the zero-audio receive bug
(#11419 / PR #11449), yet receive stays officially "stable support not
guaranteed". So every utterance logs delivered audio against the speaking
span (`voice.discord.utterance`) — silent loss cannot hide. A disconnect
logs and stays down until the next presence event; respawning belongs to the
supervisor. aivi joins self-mute; answers come back through the
TTS-to-opus lane, chunked audio played as 20 ms packets. One answer is ONE
audio resource (a `PacketBand`): chunks join it while it plays — playing each
chunk as its own resource made the player touch Idle at every seam, a ~113 ms
click every two seconds — and while synthesis falls behind, the band feeds
Discord's own silence packet to keep the player on air. A barge stops the
player and kills the band's unheard packets at once, so the next answer plays
as a fresh resource.

```json
"channel-discord": { ..., "voice": { "guild": "123456789012345678",
  "channels": ["223456789012345678"], "silenceMs": 500 } }
```

## Dependencies

`discord.js` and `@discordjs/voice` for the gateway and voice capture
(`libsodium-wrappers` for the sodium layer the voice lane needs),
`@discordjs/opus` for opus — a **native** binding, on purpose: opusscript's
shared WASM heap turned one corrupted mid-stream packet into a dead opus
subsystem process-wide (hearing *and* speaking, live-verified 2026-10-12);
native libopus throws catchably per packet and survives. Plus `@aivi/host`
as a peer (the host runs it in-process). The voice *capability*
is not a dependency: it is the optional `@aivi/voice` plugin behind the
seat.

## Docs

[discord](../../docs/discord.md) ·
[channels](../../docs/channels.md)
