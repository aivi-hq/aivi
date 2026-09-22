# People: persons, tokens, linking

aivi is a virtual colleague, and people exist so records have an owner: whose
memory, whose reminder, whose job, whose delegate message. Humans only — aivi
itself is never a person; its own work (dreaming, retention, sync) runs
in-process and authenticates to nothing.

## Attribution and association

Two words that must not blur:

- **Attribution** is which names a commit carries: the bot as author/co-author
  from aivi's identity, the human as author from their own git config. A git
  fact, owned by the worker story ([linear](linear.md)); it never consults
  whoami.
- **Association** is which person a record belongs to: link codes, job
  ownership, session stamps, memories. A host fact, taken from the calling
  bearer — never from what a message claimed. Channel identities are the one
  exception, and they associate by the paste-a-code ritual precisely because
  there is no bearer there.

## Auth: commands are open, roles gate people management

Auth is `none`, final ([architecture](architecture.md)): a request with an
unknown or missing bearer is accepted with no person attached. Tokens
**identify, never authorize** — with one exception landed 2026-09-21:
**people management is operator-only**. `whoami` still rejects anonymous
callers (it is the person lookup) and answers the caller's real roles:
`{ person: {id, name}, roles: ["operator"] }`. Roles are an **open string
array** on the person (`roles` column, JSON): `operator` manages people and
maintenance, the default for a new person is `member`; a future role is data,
not a migration. The store migration granted `operator` to everyone who
existed when the column arrived (the v1 stub was simply true). Enforcement
widens with the ops dispatcher ([plans/operator-api](plans/operator-api.md));
until then a non-loopback bind logs a warning: anyone who can reach the
address can use the commands.

## Persons and tokens (aivi.sqlite)

- `people {id, name, email?, roles, created_at}` — ids are minted `person-<8>`;
  a new person is `["member"]` unless created with explicit roles, and
  `aivi people create NAME --role operator` grants the role at creation.
- `tokens {token_hash, person_id, label, created_at}` — every token belongs to
  a person (the foreign key refuses anything else). The secret starts `aivi-`
  and is shown once at mint; only its SHA-256 hash is kept. A token is the
  bearer a client sends; it does not expire yet (revoke/rotate is backlog).

Store methods: `createPerson`, `people`, `person`, `mintToken`,
`personForToken` — the last is the lookup behind every request.

## The client config: `~/.config/aivi.json`

One file, identical shape everywhere (`XDG_CONFIG_HOME` wins when set), 0600:

```json
{
  "configVersion": 1,
  "url": "http://127.0.0.1:4100",
  "home": "/home/me/.aivi",
  "person": { "token": "aivi-…", "id": "person-…", "name": "Ada", "roles": ["operator"] }
}
```

- `person.token` — the bearer; the only secret. Absent when the machine has no
  person (channel conversations associate by their channel identity either
  way).
- `person.id`, `person.name`, `person.roles` — a display cache written by
  `aivi setup` from `whoami`. It never decides anything: real answers come
  from the host, and cached roles only shape what the CLI lists.
- `url` — the host API. The OpenCode plugin falls back to it (and to
  `person.token`) when its options say nothing — see [opencode](opencode.md).
- `home` — present only on a machine that hosts aivi: "this machine hosts".
  The home lives at `~/.aivi` and never moves.

## Bootstrap and people commands

`aivi setup` is the one entry point: it signs a machine in to a host
(connect branch) or creates the server and the operator person (create
branch) — the flow is described in
[operations](operations.md#first-run-aivi-setup). The identity minting
itself stays in the installed app's `server create`, which `aivi setup`
drives. Every other identity command talks HTTP (ungated like everything
until the api-only session):

- `aivi people create NAME [--email E]` — on a terminal it offers to mint
  the person's token right away, since nine of ten people are created for
  exactly that.
- `aivi people list`
- `aivi people token PERSON [--label L]` — mints another bearer; shown once.

## Link codes (Discord, Slack)

`aivi link [PLATFORM]` mints a one-time code (5 digits, hashed, 15 minutes,
one active per person — re-minting replaces it) and prints where to spend it.
On the channel, `/link <code>` consumes it: the identity comes from the
platform, the code is the evidence, and the host binds
`{channel, user id} → person` and confirms. A refusal — unknown, expired, or
an account that is already bound — never consumes the code, and re-binding is
refused outright: there is no unlink yet (historic sessions keep their
association), so a binding lasts until that exists. From then on the account
speaks as its person: the turn prompt carries the person's name and the
session is stamped `metadata.aivi.person`. Expired codes are swept by the
retention job. An agent tool (`aivi_link`) so linking also works from natural
language may come later; Linear needs its own redemption path and is not
linked this way yet. Email linking is deferred: the shape is a link token
sent to an inbox, with a callback URL on the public Linear route.

## Backlog

- Token revoke/rotate.
- Email as the anchor identity (stable across GitHub/Slack/Discord profiles);
  needs a mail-sender decision.
- Keychain/credential adapters: the 0600 file is the current store.
- Per-person memory files from dreaming vs `person` as a filter on indexed
  conversations.
