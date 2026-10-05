---
'@aivi/cli': minor
---

Announce first, then do the disconnecting thing: `aivi service stop` and
`aivi service restart` print `server stopping…` / `server restarting…` to
stdout before the host goes down — a session driven over the exec relay
reads the line before the drop — and both answer `not running as a service`
where no unit is installed, before touching launchctl. The notice and the
guard live in the two chokepoint functions, written synchronously so the
`spawnSync` below cannot strand the bytes. `aivi update` no longer stops the
host before npm: it installs while the server keeps answering and ends with
the announced restart, so a remote `aivi -r update` survives its own slow
part; `add` and `remove` restart through the same announced, atomic restart, which also
closes the window where a dying host could kill the updater between stop and
start and leave the service booted out.
