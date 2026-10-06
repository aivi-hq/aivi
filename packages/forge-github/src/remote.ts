/** The facts aivi reads off a git remote's URL. Kept out of `github.ts`
 *  because none of it needs a credential, a network, or octokit: this is what
 *  a checkout says about itself, and what aivi answers with.
 *
 *  What aivi answers with matters because an installation token authenticates
 *  **HTTPS and nothing else** — GitHub's ssh transport takes a key, which is a
 *  human's credential. So aivi never transfers through a checkout's own
 *  `origin`: it names the HTTPS URL of the same repository on the command line,
 *  beside the credential it supplies. A person who cloned with ssh keeps their
 *  `origin` exactly as they left it, and no byte of aivi's credential is
 *  written to the repository's config.
 */

/** One repository, as its remote names it. `host` is lower-cased (DNS is);
 *  `owner` and `repo` keep their case, which GitHub treats as display and
 *  resolves either way. */
export interface GitHubRemote {
  host: string;
  owner: string;
  repo: string;
  /** True when the URL is an ssh form — the transport aivi cannot use. */
  ssh: boolean;
}

/** The `.git` transport suffix, which names nothing. */
const stripSuffix = (path: string) => (path.endsWith('.git') ? path.slice(0, -4) : path);

/** The one host aivi speaks to as GitHub. GitHub Enterprise Server is a
 *  different host with a different install, not a detail of this parse. */
export const GITHUB_HOST = 'github.com';

/** The shorthand a person types when they mean a GitHub repository: two
 *  path segments and nothing else. GitHub's own names are letters, digits,
 *  dots, dashes and underscores; a lone `.` or `..` is a relative path, so
 *  the segments may not be all-dots. */
const BARE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const bareRemote = (raw: string): GitHubRemote | undefined => {
  const bare = BARE.exec(raw);
  if (!bare) return undefined;
  const [, owner, repo] = bare;
  if (/^\.+$/.test(owner ?? '') || /^\.+$/.test(repo ?? '')) return undefined;
  return { host: GITHUB_HOST, owner: owner!, repo: stripSuffix(repo!), ssh: false };
};

/**
 * Read a remote URL for what aivi can use: `owner/repo` and which transport it
 * names. Understands the scp-like ssh form (`git@github.com:owner/repo.git`),
 * `ssh://`, `https://` and `http://`, each with or without the `.git` suffix,
 * and the bare `owner/repo` shorthand a person types for a GitHub repository
 * (no transport to speak of, so it reads as https). Undefined for anything
 * that is not a two-segment repository path — a repository on another host,
 * a URL with a port or a nested path, or a local path, which is a checkout
 * with no remote to speak of.
 */
export function parseRemote(url: string): GitHubRemote | undefined {
  const raw = url.trim();
  if (!raw || raw.startsWith('-')) return undefined;
  // `git@github.com:owner/repo.git` — scp syntax, no scheme to parse.
  const scp = /^([^/@\s]+)@([^/:]+):(.+)$/.exec(raw);
  if (scp && !raw.includes('://')) {
    const [, , host, path] = scp;
    const segments = stripSuffix(path ?? '')
      .split('/')
      .filter(Boolean);
    if (!host || segments.length !== 2) return undefined;
    return { host: host.toLowerCase(), owner: segments[0]!, repo: segments[1]!, ssh: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // No scheme to parse: the only other thing that names a repository is the
    // bare `owner/repo`, which can only mean the one host this forge speaks.
    return bareRemote(raw);
  }
  if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return undefined;
  if (parsed.port) return undefined;
  const segments = stripSuffix(parsed.pathname).split('/').filter(Boolean);
  if (segments.length !== 2) return undefined;
  return {
    host: parsed.hostname.toLowerCase(),
    owner: segments[0]!,
    repo: segments[1]!,
    ssh: parsed.protocol === 'ssh:',
  };
}

/** True when the remote is GitHub's own host — the only one this forge
 *  claims. Another host is another forge's turn, said silently: a project on
 *  GitLab is not an error here. */
export function isGitHub(remote: GitHubRemote): boolean {
  return remote.host === GITHUB_HOST;
}

/** The URL aivi authenticates: the same repository over HTTPS. Every transfer
 *  names this URL on the command line instead of a remote's name, so the
 *  credential aivi supplies is the one git uses — no rewrite of the checkout's
 *  own config, and no chance of a stored credential being preferred instead. */
export function httpsRemote(remote: GitHubRemote): string {
  return `https://${GITHUB_HOST}/${remote.owner}/${remote.repo}.git`;
}
