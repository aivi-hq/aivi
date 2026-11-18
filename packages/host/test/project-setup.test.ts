import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectContributor } from '@aivi/plugin';
import { listLaneAgents, projectSetupPlan, runProjectSetup } from '../src/cli/project-setup.ts';
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

/** The fake service a location boot needs: `load` marks the directory known,
 *  and the agent list answers `after` from the second sight on — the first
 *  sight answers empty, as a booting location does. `gap` records every
 *  asked wait instead of waiting: no test sleeps. The client is assembled
 *  from the parts where it is handed over, cast once at that crossing. */
function bootingService(answersOnSecondAsk = true) {
  const calls: string[] = [];
  let sighted = false;
  const location = {
    get: async () => {
      calls.push('load');
      return { directory: 'x', project: { id: 'p', directory: '', canonical: '' } };
    },
  };
  const list = async () => {
    calls.push('list');
    const ready = sighted ? answersOnSecondAsk : false;
    sighted = true;
    return {
      data: ready
        ? [
            { id: 'developer', mode: 'primary' },
            { id: 'explore', mode: 'subagent' },
          ]
        : [],
    };
  };
  const client = { location, agent: { list } } as never;
  const sleep = async (ms: number) => {
    calls.push(`gap:${ms}`);
  };
  return { client, location, list, calls, sleep };
}

test('the location is loaded before the agent list is asked, and a first answer needs no second ask', async () => {
  // The live failure this pins: the first wizard run after a service restart
  // died with "no agents available" while the retry passed. A location the
  // service has never seen boots asynchronously; location.get starts the
  // boot. A service that answers the first list (one that knew the
  // location) is asked once — the gap belongs to the empty answer alone.
  const home = mkdtempSync(join(tmpdir(), 'aivi-lane-agents-'));
  const service = bootingService();
  const client = {
    location: service.location,
    agent: {
      list: async () => {
        service.calls.push('list');
        return {
          data: [
            { id: 'developer', mode: 'primary' },
            { id: 'explore', mode: 'subagent' },
          ],
        };
      },
    },
  } as never;
  const agents = await listLaneAgents(
    home,
    { config: { opencode: {} } } as never,
    'shop',
    () => Promise.resolve(client),
    service.sleep,
  );
  rmSync(home, { recursive: true, force: true });
  assert.deepEqual(service.calls, ['load', 'list'], 'the load comes before the list, and one ask answers');
  assert.deepEqual(agents, ['developer'], 'a lane works as a primary; the subagent-only one never shows');
});

test('an empty first list is asked again after the one-second gap — the gap is the fake, never the wait', async () => {
  // The cold-boot capture: the first list races the location's boot and
  // answers empty; a second ask a moment later answers the agents. The
  // wizard asks twice; the gap lands as a recorded call — a real second
  // of sleeping in a test would say this pin is wrong.
  const home = mkdtempSync(join(tmpdir(), 'aivi-lane-agents-'));
  const service = bootingService();
  const agents = await listLaneAgents(
    home,
    { config: { opencode: {} } } as never,
    'shop',
    () => Promise.resolve(service.client),
    service.sleep,
  );
  rmSync(home, { recursive: true, force: true });
  assert.deepEqual(
    service.calls,
    ['load', 'list', 'gap:1000', 'list'],
    'load, empty answer, the ruled one-second gap, the second ask — no more',
  );
  assert.deepEqual(agents, ['developer'], 'the boot lands inside the gap, as it does live');
});

test('two empty asks answer empty: the wizard says its own error, and no third wait is taken', async () => {
  // A genuine zero is the wizard's error to say ("there appear to be no
  // agents available"), not a loop of waits: the gap is taken once, never
  // again, and the empty answer stands.
  const home = mkdtempSync(join(tmpdir(), 'aivi-lane-agents-'));
  const service = bootingService(false);
  const agents = await listLaneAgents(
    home,
    { config: { opencode: {} } } as never,
    'shop',
    () => Promise.resolve(service.client),
    service.sleep,
  );
  rmSync(home, { recursive: true, force: true });
  assert.deepEqual(service.calls, ['load', 'list', 'gap:1000', 'list'], 'two asks, one gap, then the answer');
  assert.deepEqual(agents, [], 'empty stands as the genuine zero the wizard reports');
});

test('a named project in a home without a forge is set up untracked, and only at a terminal', async t => {
  const home = mkdtempSync(join(tmpdir(), 'aivi-project-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, JSON.stringify({ version: 1 }));
  t.mock.property(process, 'env', { ...process.env, AIVI_HOME: home });
  const attached = process.stdin.isTTY;
  const terminal = (value: boolean | undefined) =>
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  t.after(() => terminal(attached));

  terminal(false);
  await assert.rejects(
    runProjectSetup({ home, configPath, name: 'research' }),
    /projects add needs an interactive terminal; to set a project up without one, write its block in config\.json/,
  );
  assert.equal(existsSync(join(home, 'projects')), false, 'a refusal makes nothing');

  terminal(true);
  // The wizard's last line goes straight to the terminal. It is watched on its
  // way through and never held back: the test runner reports over the same pipe.
  const said = t.mock.method(process.stdout, 'write');
  const settled = await runProjectSetup({ home, configPath, name: 'research' });
  said.mock.restore();
  assert.equal(settled, 'research', 'the name given is the project, and nobody is asked for it');
  assert.match(
    said.mock.calls.map(call => String(call.arguments[0])).join(''),
    /research has no source host \(no forge configured\); its directory is untracked and holds a note\. Restart `aivi serve` to index it\./,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(configPath, 'utf8')),
    { version: 1, projects: { research: { sync: false } } },
    'the project is named in the config, and the sync is told it has no business there',
  );
  assert.match(readFileSync(join(home, 'projects', 'research', 'source', 'AGENTS.md'), 'utf8'), /^# No source/);
});
