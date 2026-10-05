/** The forge registry: who owns a project's remote. Registration is the
 *  module's, the question is the machinery's, and the answer may be nobody
 *  (docs/plans/forge-github.md: the forge is a configurable path, not the
 *  spine). */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Forge, ForgeProject, RepoRef } from '@aivi/plugin/forge';
import { Forges } from '../src/forges.ts';

/** A forge that owns exactly the repositories named for it, and says its
 *  name when it answers — so the test sees whose turn came and whose did not. */
class NamedForge {
  readonly name: string;
  calls: string[] = [];
  private readonly owns: string[];
  constructor(name: string, owns: string[]) {
    this.name = name;
    this.owns = owns;
  }
  async repoFor(project: ForgeProject): Promise<RepoRef | undefined> {
    this.calls.push(project.id);
    return this.owns.includes(project.id)
      ? { id: `${this.name}/${project.id}`, remote: `https://${this.name}/x` }
      : undefined;
  }
}

test('the registry answers who owns the remote: the first forge that recognises it wins', async () => {
  const forges = new Forges();
  const gitlab = new NamedForge('gitlab', ['site']);
  const github = new NamedForge('github', ['site', 'api']);
  const unregistered = new NamedForge('other', ['site']);
  forges.register(github as unknown as Forge);
  forges.register(gitlab as unknown as Forge);

  const owned = await forges.owner({ id: 'site', directory: '/projects/site/source' });
  assert.equal(owned?.forge, github, 'the first registrant that recognises the remote owns it');
  assert.equal(owned?.repo.id, 'github/site');
  assert.deepEqual(gitlab.calls, [], 'a forge that already has an owner is never asked');

  assert.equal(await forges.owner({ id: 'plain', directory: '/projects/plain/source' }), undefined, 'nobody owns it');
  assert.deepEqual(unregistered.calls, [], 'a forge that never registered is never asked');
});

test('unregistration takes the forge out of the question', async () => {
  const forges = new Forges();
  const github = new NamedForge('github', ['site']);
  const unregister = forges.register(github as unknown as Forge);
  assert.equal((await forges.owner({ id: 'site', directory: '/x' }))?.repo.id, 'github/site');
  unregister();
  assert.equal(await forges.owner({ id: 'site', directory: '/x' }), undefined, 'the answer is nobody again');
});
