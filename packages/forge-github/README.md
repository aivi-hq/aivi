# @aivi/forge-github

The GitHub forge: the remote a project came from, the pull requests over its
branches, and the review conversation on them. aivi speaks as **its own app** —
one installation, one token octokit owns the whole life of — never as the
person at the keyboard.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/forge-github` | `GitHubApp`, `createGitHubForge`, `createForgeGithubModule` |
| `@aivi/forge-github/config` | the registry declaration: module id and `plugins.forge-github` schema |
| `@aivi/forge-github/setup` | the guide `aivi add` runs |
| `@aivi/forge-github/setupProject` | the `forge`-role contributor `aivi projects add` runs |

## Model

- **Remote is the line.** Anything that reaches `origin` authenticates and so
  belongs here: clone, fetch, the `source/` sync, push. Worktrees and commits
  stay with whoever works locally, and this package never performs them.
- **One installation and only one.** An installation is the grant from an
  account to the app; zero or several is a setup error naming what to fix,
  never a mode.
- **The credential goes in the command's own environment**, and the URL is
  named on the command line rather than read from the checkout: a token is left
  in no file, and the person's stored credential is never offered.
- **Every post names its worker**, in the text a person reads — so the review
  a wake is handed can tell aivi's own comments from a human's replies.

## Status

The contract, the credential and the transfers are built and tested against a
scripted GitHub and a real local repository. Nothing asks a forge a question
yet: the host-side forge registry — the first thing with "who owns this
project's remote?" to ask — arrives with the orchestrator.

## Dependencies

`octokit` and `@octokit/auth-app`; `@aivi/host` as a peer (the module runs
in-process with the host).

## Docs

[plan (the contract, the boundary, what is left)](../../docs/plans/forge-github.md)
