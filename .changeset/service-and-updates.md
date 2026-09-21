---
'aivi': minor
'@aivi/core': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/linear': minor
---

The CLI can run the server in the background and update it. `aivi service
install|uninstall|start|stop|restart|status|logs` wrap a per-user LaunchAgent
(macOS) or systemd user unit (Linux). `aivi update` resolves the channel from
`config.json` (`update.channel`, default stable), provisions `runtime/` Node
when the target demands it, stops the server, installs via npm — whose peer
resolution pins a plugin at "disabled: no compatible release" when its range
excludes the new host — restarts and probes `/health`. `aivi upgrade` updates
the CLI through npm. Channel plugins now declare `@aivi/host` as a
peerDependency, making npm the compatibility resolver.
