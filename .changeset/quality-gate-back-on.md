---
'@aivi/core': minor
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/cli': minor
'@aivi/browser': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/forge-github': minor
'@aivi/tracker-linear': minor
---

**Quality gate back on, and green where it counts.** `npm run quality`
(fallow) runs again at the end of `agentic:verify`, and the sweep it was
disabled for is done: the dead exports and members it reported are gone
(`ConversationStore.rebind`, `Dispatcher.idleTimeoutMs`,
`LeaseStore.bySession`, `RunLinks.release`, the `worktreeHolding` /
`SECTION` / wizard-helper exports nobody imported), the three copies of
the wizard's `settled` live once in `@aivi/plugin`, the `ISO_INSTANT`
regex moved to the time file that actually decides with it (breaking
core's only import cycle), the ledger's three feedback patches became
one, and the private types that leaked into exported signatures are
exported. The plugin declarations' lazy `import('./module.ts')` — the
design that keeps the CLI's config read cheap — carries a named
suppression instead of a false alarm, as do the two host modules the CLI
imports by string path from the installed server. What remains failing:
22 advisory health targets (file-split suggestions), reported to the
operator.
