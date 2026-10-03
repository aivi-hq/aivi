// The redirect: aivi's own permission deny, the attribution plugin's shape
// (docs/plans/git-workflow.md). Boundary git — the commands that cross to
// the remote — is refused in **aivi's runs only**, with a message pointing at
// the tool that does it as the app. Scoped by the one fact the plugin has:
// `sessionID`; the host's ledger answers once per session and the answer is
// cached, so a person's sessions never see the deny. Honest edges: a
// checkout lane has no no-credential mark, so there the hook is guardrail
// without the wall; and a boundary git that slips past both has no credential
// to spend anyway — the wall is the safety, the hook is courtesy.

/** The git verbs that cross the remote boundary. */
const BOUNDARY = ['push', 'fetch', 'pull', 'clone', 'ls-remote', 'remote'] as const;
export type BoundaryGit = (typeof BOUNDARY)[number];

/** git's global flags that consume the token after them, so the verb behind
 *  a `-c x=y` prefix is still recognised. */
const VALUE_FLAGS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);

/** The `git remote` sub-verbs that read local config and never cross: the
 *  name list and one URL. `show` is not among them — it asks the remote. */
const REMOTE_READS = new Set(['get-url']);

/** The boundary verb a shell resource spends, if it spends one. OpenCode's
 *  scanner already split chained commands into separate resources; whitespace
 *  inside one is collapsed here, as the attribution plugin does. */
export function boundaryGit(resource: string): BoundaryGit | undefined {
  const tokens = resource.trim().replace(/\s+/g, ' ').split(' ');
  if (tokens[0] !== 'git') return undefined;
  for (let at = 1; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (VALUE_FLAGS.has(token)) at++;
    else if (token.startsWith('-')) continue;
    else if (token === 'remote') {
      // Listing remotes and reading one URL is local config, not a
      // crossing; rewriting them is. A sub-verb unknown here stays
      // refused: the wall is the safety, the hook is courtesy.
      const sub = tokens.slice(at + 1).find(t => !t.startsWith('-'));
      return sub === undefined || REMOTE_READS.has(sub) ? undefined : ('remote' as BoundaryGit);
    } else return (BOUNDARY as readonly string[]).includes(token) ? (token as BoundaryGit) : undefined;
  }
  return undefined;
}

/** The words the worker sees instead of the command: never a bare no, always
 *  the way across. The push line is the plan's, verbatim. */
export function redirectMessage(verb: BoundaryGit): string {
  if (verb === 'push')
    return 'git push is disabled in aivi runs — use aivi_push (and aivi_sync first if the remote moved).';
  if (verb === 'fetch' || verb === 'pull')
    return 'git fetch and git pull are disabled in aivi runs — use aivi_sync to bring the remote’s latest refs in; integrate them with your own git.';
  if (verb === 'remote')
    return 'changing remotes is disabled in aivi runs: aivi owns the way across (aivi_sync, aivi_push, aivi_pr). If none of them does what you need, ask the person with aivi_ask.';
  return `git ${verb} is disabled in aivi runs: aivi crosses to the remote through its own tools (aivi_sync, aivi_push, aivi_pr). If none of them does what you need, ask the person with aivi_ask.`;
}

/** The evaluation, in the words this file reasons over: the kit's
 *  `PermissionEvaluation` with `effect` left writable. */
export interface EvaluationLike {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: string;
  message?: string;
}

/**
 * The `permission.evaluate` hook, with membership injected: asked once per
 * session, cached by the caller. Not a run (or the host unreachable — fail
 * open, the wall stays the safety) and the evaluation stands untouched.
 */
export function makeRedirect(isRun: (sessionID: string) => Promise<boolean>) {
  return async (event: EvaluationLike): Promise<void> => {
    if (event.action !== 'shell') return;
    const verb = event.resources.map(boundaryGit).find(found => found !== undefined);
    if (!verb) return;
    if (!(await isRun(event.sessionID))) return;
    event.effect = 'deny';
    event.message = redirectMessage(verb);
  };
}
