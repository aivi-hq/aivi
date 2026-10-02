---
'@aivi/cli': patch
'@aivi/channel-discord': patch
'@aivi/channel-slack': patch
---

Documentation of the built thing: operations.md gained *Running remotely*
(the `/exec` transport, the closed child env, the visibility table of who
refuses `--remote` and with which words, the `(remote)` banner, the
announce-before-drop); people.md's auth section tells the `operator` gate in
present tense; CONTEXT.md adds the words *exec channel / relay* and *driven
session*; the CLI README's command table gained `--remote`, the per-state
membership note, and a fix of the stale `aivi install` rows (here and in the
channel READMEs — the command is `aivi add`). The relay's
`no server configured` answer now names `aivi setup`, the command that
exists today.
