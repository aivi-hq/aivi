---
'@aivi/host': patch
---

`AIVI_OPERATOR_BEARER` joined the fixed secret names a shell task never
inherits (decision D15): the exec door stamps the remote driver's own bearer
into the driven session's closed environment, and the name is now scrubbed
from task scripts' env too, so an operator's credential cannot leak into a
task script however it entered the host's environment. The scrub test proves
it at the executor boundary; configuration.md owns the words.
