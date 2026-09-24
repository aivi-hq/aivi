---
'@aivi/core': minor
'@aivi/app': minor
'@aivi/host': minor
'@aivi/channel-slack': minor
---

Command output is readable on a terminal and unchanged JSON in a pipe. Core
gains an output renderer (`OutputBlock`, `renderOutput`, `formatTimestamp`,
`print`): without a hand-written shape a command's value is shown as colored
`util.inspect`; a command may pass blocks (log, heading, divider, table, raw
`json`) instead — `aivi slack manifest` renders raw JSON so it stays
paste-ready. Help loses its color theme; the wordmark stays.
