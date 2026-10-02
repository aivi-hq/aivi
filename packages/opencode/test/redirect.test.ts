import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundaryGit, type EvaluationLike, makeRedirect, redirectMessage } from '../src/redirect.ts';

test('the boundary verbs are recognised behind any flags or -c prefixes', () => {
  assert.equal(boundaryGit('git push'), 'push');
  assert.equal(
    boundaryGit('  git   push  origin  HEAD  '),
    'push',
    'whitespace is collapsed, as the scanner leaves it',
  );
  assert.equal(boundaryGit('git -c protocol.version=2 push'), 'push');
  assert.equal(boundaryGit('git --no-pager fetch origin'), 'fetch');
  assert.equal(boundaryGit('git -C /w pull'), 'pull');
  assert.equal(boundaryGit('git ls-remote origin'), 'ls-remote');
  assert.equal(boundaryGit('git remote get-url origin'), 'remote');
  assert.equal(boundaryGit('git clone https://github.com/acme/widget.git'), 'clone');
});

test('local git stays itself: the deny never reaches past the boundary', () => {
  for (const local of [
    'git status',
    'git commit -m push',
    'git stash push',
    'git log --grep fetch',
    'git checkout main',
    'git cherry HEAD refs/remotes/origin/main',
    'git rev-parse HEAD',
    'git',
    'npm run build',
  ])
    assert.equal(boundaryGit(local), undefined, `${local} is not boundary git`);
});

test('the refusal names the way across, never a bare no', () => {
  assert.equal(
    redirectMessage('push'),
    'git push is disabled in aivi runs — use aivi_push (and aivi_sync first if the remote moved).',
    "the plan's line, verbatim",
  );
  assert.match(redirectMessage('fetch'), /aivi_sync/);
  assert.match(redirectMessage('clone'), /aivi_ask/);
});

test('the hook denies only aivi’s runs: a person’s session is never touched', async () => {
  const asked: string[] = [];
  const evaluate = makeRedirect(async sessionID => {
    asked.push(sessionID);
    return sessionID === 'ses_run';
  });

  const run: EvaluationLike = {
    sessionID: 'ses_run',
    action: 'shell',
    resources: ['git push origin'],
    effect: 'allow',
  };
  await evaluate(run);
  assert.equal(run.effect, 'deny', 'the run’s push is refused');
  assert.match(run.message ?? '', /aivi_push/);

  const person: EvaluationLike = {
    sessionID: 'ses_person',
    action: 'shell',
    resources: ['git push origin'],
    effect: 'allow',
  };
  await evaluate(person);
  assert.equal(person.effect, 'allow', 'the person next door pushes freely');
  assert.equal(person.message, undefined);

  const local: EvaluationLike = { sessionID: 'ses_run', action: 'shell', resources: ['git status'], effect: 'allow' };
  await evaluate(local);
  assert.equal(local.effect, 'allow', 'and the run’s local git never summons the question');
  assert.deepEqual(asked, ['ses_run', 'ses_person'], 'membership is asked only when the command is boundary git');
});

test('only shell commands are evaluated, and one boundary resource condemns the call', async () => {
  const evaluate = makeRedirect(async () => true);
  const edit: EvaluationLike = { sessionID: 'ses_run', action: 'edit', resources: ['git push'], effect: 'allow' };
  await evaluate(edit);
  assert.equal(edit.effect, 'allow', 'not a shell call');

  const chained: EvaluationLike = {
    sessionID: 'ses_run',
    action: 'shell',
    resources: ['git add .', 'git commit -m x'],
    effect: 'allow',
  };
  await evaluate(chained);
  assert.equal(chained.effect, 'allow', 'a chain of local commands stands');

  const smuggled: EvaluationLike = {
    sessionID: 'ses_run',
    action: 'shell',
    resources: ['git add .', 'git push origin HEAD'],
    effect: 'allow',
  };
  await evaluate(smuggled);
  assert.equal(smuggled.effect, 'deny', 'one boundary command in the chain is enough');
});
