import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_HOST, httpsRemote, isGitHub, parseRemote } from '../src/remote.ts';

test('every form a remote arrives in is read for what aivi can use', () => {
  assert.deepEqual(parseRemote('https://github.com/owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    ssh: false,
  });
  assert.deepEqual(parseRemote('https://github.com/owner/repo'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    ssh: false,
  });
  assert.deepEqual(parseRemote('git@github.com:owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    ssh: true,
  });
  assert.deepEqual(parseRemote('ssh://git@github.com/owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    ssh: true,
  });
  assert.equal(GITHUB_HOST, 'github.com');
});

test('what a remote says about its host is kept as said, but the host is matched case-insensitively', () => {
  const remote = parseRemote('HTTPS://GitHub.com/Owner/Repo.git');
  assert.deepEqual(remote, { host: 'github.com', owner: 'Owner', repo: 'Repo', ssh: false });
  // GitHub resolves either spelling and shows the one it was given, so aivi
  // carries the case it read and never rewrites a person's repository name.
  assert.equal(httpsRemote(remote!), 'https://github.com/Owner/Repo.git');
});

test('another host is another forge’s turn, and it is the parse that says which host it is', () => {
  const gitlab = parseRemote('https://gitlab.com/owner/repo.git');
  assert.ok(gitlab);
  assert.equal(isGitHub(gitlab!), false);
  assert.equal(isGitHub(parseRemote('https://github.com/owner/repo.git')!), true);
});

test('a credential stored in the origin is not carried along: aivi answers the repository, not the person’s secret', () => {
  // A checkout whose URL holds a token is a person's own doing; the facts aivi
  // takes from it are the repository, and its own credential is what aivi uses.
  const remote = parseRemote('https://user:ghp_secret@github.com/owner/repo.git');
  assert.deepEqual(remote, { host: 'github.com', owner: 'owner', repo: 'repo', ssh: false });
});

test('anything that is not one repository path on one host is no remote at all', () => {
  for (const written of [
    '',
    '   ',
    '-C', // never an option aivi would run
    '/srv/git/repo.git',
    './repo',
    'github.com/owner/repo',
    'https://github.com/owner/repo/extra',
    'https://github.com/owner',
    'https://github.com:8443/owner/repo.git',
    'ftp://github.com/owner/repo.git',
    'file:///srv/git/repo.git',
    'git@github.com:owner/repo/extra.git',
  ])
    assert.equal(parseRemote(written), undefined, `${written} names no repository`);
});
