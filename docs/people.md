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

## Auth: commands are open

Auth is `none`, final ([architecture](architecture.md)): a request with an
unknown or missing bearer is accepted with no person attached. Tokens
**identify, never authorize**. Exactly two endpoints reject anonymous callers,
because their answers must be attached to a person: `GET /v1/whoami` (it is
the person lookup) and link creation. `whoami` answers
`{ person: {id, name}, roles: ["operator"] }` — the roles are a v1 stub that
is simply true today (one user, local); real per-person roles arrive with the
api-only session. Until then a non-loopback bind logs a warning: anyone who
can reach the address can use the commands.

## Persons and tokens (aivi.sqlite)

- `person {id, name, email?, created_at}` — ids are minted `person-<8>`.
- `token {token_hash, person_id, label, created_at}` — every token belongs to
  a person (the foreign key refuses anything else). The secret starts `aivi-`
  and is shown once at mint; only its SHA-256 hash is kept. A token is the
  bearer a client sends; it does not expire yet (revoke/rotate is backlog).

Store methods: `createPerson`, `people`, `person`, `mintToken`,
`personForToken` — the last is the lookup behind every request.

## The client config: `~/.config/aivi.json`

One file, identical shape everywhere (`XDG_CONFIG_HOME` wins when set), 0600:

```json
{ "configVersion": 1, "url": "http://127.0.0.1:4100", "home": "/home/me/.aivi", "person": { "token": "aivi-…" } }
```

- `person.token` — the bearer; the only secret. Absent when the machine has no
  person (channel conversations associate by their channel identity either
  way).
- `url` — the host API.
- `home` — present only on a machine that hosts aivi: "this machine hosts".
  The home lives at `~/.aivi` and never moves.

## Bootstrap and people commands

`aivi server create` is the only command that mints identity directly:
initialize the home, create the operator person and their token, then ask
where the client setup happens — *this machine* writes the client config,
*another machine* prints the token to take to `aivi setup`
([operations](operations.md#first-run-server-create)). Every other identity
command talks HTTP (ungated like everything until the api-only session):

- `aivi people create NAME [--email E]`
- `aivi people list`
- `aivi people token PERSON [--label L]` — mints another bearer; shown once.

## Link codes (Discord, Slack, Linear)

`aivi link <platform>` asks the host for a one-time code (`aivi-<random>`,
hashed, ~15 minutes), and the person pastes it anywhere the bot reads. The
inbox matches codes **before** a message becomes a turn, binds
`{module, channel user id} → person`, and confirms. After the binding, that
channel identity is the person for everything said there. Email linking is
deferred: the shape is a link token sent to an inbox, with a callback URL on
the public Linear route.

## Backlog

- Token revoke/rotate.
- Email as the anchor identity (stable across GitHub/Slack/Discord profiles);
  needs a mail-sender decision.
- Keychain/credential adapters: the 0600 file is the current store.
- Per-person memory files from dreaming vs `person` as a filter on indexed
  conversations.
