---
"@aivi/host": patch
---

Fix `--project` on `aivi sources` and `aivi knowledge search`: the first `--project` value ended the command with an error, because the option's collector expected a list that commander does not hand over for the first value. It now starts the list.
