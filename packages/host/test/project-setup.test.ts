import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectContributor } from '@aivi/plugin';
import { projectSetupPlan } from '../src/cli/project-setup.ts';
import type { ProjectContributorEntry } from '../src/cli/registry.ts';

/** A contributor entry carrying only what the plan reads; the setup body is
 *  never called by the plan, so a stub suffices. */
function entry(moduleId: string, role?: 'forge' | 'tracker'): ProjectContributorEntry {
  const contributor = { setup: async () => ({ id: moduleId }) } as unknown as ProjectContributor;
  return { name: `@aivi/${moduleId}`, moduleId, ...(role ? { role } : {}), contributor };
}

test('the plan walks core roles in order, then the roleless plugins', () => {
  const all = [entry('extra'), entry('lin', 'tracker'), entry('gh', 'forge')];
  const plan = projectSetupPlan(all, () => true);
  assert.deepEqual(
    plan.roles.map(r => r.role),
    ['forge', 'tracker'],
    'core spells the roles and the order, whatever the list order',
  );
  assert.deepEqual(
    plan.roles.map(r => r.candidates.map(c => c.moduleId)),
    [['gh'], ['lin']],
    'each role collects the contributors that named it, not by list order',
  );
  assert.deepEqual(
    plan.extras.map(c => c.moduleId),
    ['extra'],
    'a contributor with no role jumps in after the roles',
  );
});

test('a contributor runs only when its plugin is configured', () => {
  const all = [entry('gh', 'forge'), entry('lin', 'tracker'), entry('extra')];
  const plan = projectSetupPlan(all, id => id !== 'lin' && id !== 'extra');
  assert.deepEqual(
    plan.roles.map(r => r.candidates.map(c => c.moduleId)),
    [['gh'], []],
    'an unconfigured tracker is skipped',
  );
  assert.deepEqual(plan.extras, [], 'an unconfigured roleless plugin does not run');
});

test('a role with several configured plugins is a choice; roleless plugins all run', () => {
  const all = [entry('gh', 'forge'), entry('gl', 'forge'), entry('a'), entry('b')];
  const plan = projectSetupPlan(all, () => true);
  assert.deepEqual(
    plan.roles[0]!.candidates.map(c => c.moduleId),
    ['gh', 'gl'],
    'two forges stay both — the runner asks which, since only one owns the checkout',
  );
  assert.deepEqual(
    plan.extras.map(c => c.moduleId),
    ['a', 'b'],
    'two roleless plugins both run — each writes its own section, no collision',
  );
});

test('no contributors at all is an empty plan, not an error', () => {
  const plan = projectSetupPlan([], () => true);
  assert.deepEqual(
    plan.roles.map(r => r.candidates),
    [[], []],
    'every core role is still listed, empty — the runner then just asks a name',
  );
  assert.deepEqual(plan.extras, []);
});
