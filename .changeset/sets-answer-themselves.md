---
'@aivi/cli': minor
'@aivi/host': minor
'@aivi/plugin': minor
---

The command sets answer the channel themselves, from the machine fact rather than a blocklist. `MachineStatus` carries two more facts: `remote` (this process is the far end of an exec session — the door stamps `AIVI_EXEC_SESSION` into the child's closed env) and `clientConfig` (the client record's path, which decides `configure`'s membership the day it lands). A driven session refuses the commands that act on the machine you type on (`setup`, `upgrade`) with `this acts on the machine you type on`, refuses to `uninstall` the home it is driving, and refuses to chain a second `-r` hop. Over the channel `serve` refuses too — the server is the thing being driven — and locally it now answers `server already running at <url>` when a host already holds its configured endpoint, instead of trying to boot a second one. Help shows the whole truth either way; a refused command is refused when run, never hidden from the page.
