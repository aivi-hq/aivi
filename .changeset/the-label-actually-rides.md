---
'@aivi/tracker-linear': minor
---

**The human label rides in production.** `LinearPlatform.apply` handled
`comment` and `move` and threw "cannot apply label yet" for everything
else — while the module had asked it for a `label` update on every stop,
every failed closing, and every unconfirmed stop since the stop-sticks
ruling. The throw was caught, warned as `help.label.failed`, and the
ticket stayed unmarked: the walk read the stopped ticket straight back.
Only the test fake had learned to mutate labels; the real adapter had
never applied one. The client now resolves a label name against the
team's labels (the team's own wins over the workspace's, and a name none
carries is created on the team — no settings visit needed to make
`needs-human` applicable) and performs `issueAddLabel` /
`issueRemoveLabel`. The quality scan's dead-code report exposed it: the
`apply` doc comment claimed "nothing on today's path asks for one" while
three paths did.
