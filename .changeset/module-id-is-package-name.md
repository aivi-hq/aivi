---
'@aivi/tracker-linear': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/core': minor
'@aivi/host': patch
'@aivi/plugin': patch
---

**A plugin's module id is its package's short name.** Ruled 2026-09-30, the
channels the day after: the word a person typed into `aivi add` is the word
they write in `config.json`, so nobody opens a source file to learn what to
call a plugin. Linear's module id is `tracker-linear`, Discord's
`channel-discord` and Slack's `channel-slack`, which rename their config
blocks (`plugins.tracker-linear`, `plugins.channel-discord`,
`plugins.channel-slack`), Linear's project section (under both `projects.<id>`
and `projectDefaults`), their `/status` ids and their log categories.
`@aivi/forge-github` and `@aivi/browser` already read this way. The Linear
installer reads and writes its block through the same `MODULE_ID` constant
its declaration exports — no second spelling of the key survives in the
package.

What keeps the platform's short name is everything naming the **platform**
rather than the package, and it is unchanged: the SQLite prefixes
(`<platform>_turns`), the session and message id prefixes (`ses_linear_…`),
the lease owners, `metadata.aivi.origin`, the webhook URL Linear's dashboard
holds, and the `aivi linear`/`aivi discord`/`aivi slack` commands. Renaming a
prefix would leave every conversation already bound in a database pointing at
a table nobody opens again, and the old tables sitting there for ever; the
host's channel and module contracts now say so in their own words.

Core loses one GitHub fact it never read: `identity.github.app` and the `app`
field of `AIVI_AGENT_BOT` are gone, no migration and no alias, because there
is no installed config to break. The app id belongs to whoever mints a token
as the app, which is `plugins.forge-github.app`; core keeps the commit pair —
name and email — and knows no forge.

The host quotes the identifiers it builds from a platform id. Unquoted, an id
carrying dashes reads to SQLite as `tracker` minus `linear_turns`, and a
third-party adapter would die at its first `CREATE TABLE`; quoting renames
nothing, since `"linear_turns"` is the table `linear_turns` was, and the test
is that dashed id meeting a real database.
