---
'@aivi/forge-github': patch
---

**The setup says where everything is.** `aivi add @aivi/forge-github` asked
for an App ID and a key path as bare prompts — where do those come from? The
flow now prints the whole of what a person does on GitHub before asking
anything: the app-creation URL, the repository permissions the forge spends
(Contents and Pull requests read & write, Issues for a future tracker),
where the App ID sits on the app page, where the .pem download comes from,
and the install step with "Only select repositories" — plus the line about
approving pending access on an already-installed app. The key prompt says
its file is read once and the key saved in the home's `.env`, because a
path a tool never remembers is not a path to curate.
