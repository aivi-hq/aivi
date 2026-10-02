---
'@aivi/cli': minor
---

`aivi configure` — the client record's second writer, and the machine
fact's first consumer. `aivi configure` shows the record (host, home, app
dir, and the signed-in person by name — never by token); with
`--url/--home/--app-dir` it edits it, refusing anything that is not an
http(s) URL or an existing directory. It never touches the person: the
token is audit evidence, and the most a person can become is *disabled*,
a server-side people decision. It is registered exactly where a client
record exists — existence, not parseability, because a broken record is
exactly what the command repairs (a record that does not parse is written
fresh around the fields that survive; a person block survives only when
its token does) — and it refuses `--remote` like the rest of the
client-side set. Along the way the record gained one honest loader:
commands that take hints from it (Node, app dir, install method) read an
unloadable file as none instead of dying on the schema dump, so a broken
record no longer bricks `aivi uninstall`; the exec relay, the one site
that *signs* with the record, reads the bytes itself and fails by name.
