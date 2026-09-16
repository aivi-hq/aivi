// Live OpenCode v2 boundary check. Requires a running `opencode service` and, for
// the prompt step, a configured provider. Not part of `npm run check`.
//
//   node scripts/live-opencode.mjs                       # discovery + auth + session round trip
//   node scripts/live-opencode.mjs --plugin DIR          # also assert the aivi plugin is active for DIR
//   MODEL=github-copilot/gemini-3.8-flash node scripts/live-opencode.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const { values } = parseArgs({
  options: { plugin: { type: 'string' }, 'skip-prompt': { type: 'boolean' }, restart: { type: 'boolean' } },
});
// Provider ids may themselves contain '/', so split on the first one only.
const model = process.env.MODEL ?? 'github-copilot/gemini-3.8-flash';
const providerID = model.slice(0, model.indexOf('/'));
const modelID = model.slice(model.indexOf('/') + 1);
const report = (name, detail) => console.log(`ok  ${name}${detail ? `  ${detail}` : ''}`);

// 1. Discovery and authentication. Basic auth only, bearer -> 401. `--restart` first restarts the
// service (a newer aivi build may need a newer service): the registration is the contract.
if (values.restart) {
  report('stop', (await Service.stop({ pty: 'handoff' })) ? 'stopped' : 'nothing was running');
  const started = await Service.ensure({ onStart: reason => report('ensure', reason) });
  assert.ok(started, 'could not start the service');
}
const endpoint = await Service.discover();
assert.ok(endpoint, 'No running OpenCode service; run `opencode service start` (or --restart)');
report('discover', `${endpoint.url} auth=${endpoint.auth?.type ?? 'none'}`);
if (endpoint.auth) {
  assert.equal((await fetch(`${endpoint.url}/api/status`)).status, 401);
  assert.equal(
    (await fetch(`${endpoint.url}/api/status`, { headers: { authorization: `Bearer ${endpoint.auth.password}` } }))
      .status,
    401,
  );
  report('auth', 'anonymous and bearer rejected, basic accepted');
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const health = await client.server.status();
assert.ok(health.version, 'server status reports a version');
report('status', `version=${health.version}`);

// 2. Plugin activation for a directory (optional).
if (values.plugin) {
  // 2.0.4 has no awaitActivation: `check` evaluates the location now.
  const plugins = await client.plugin.check({ location: { directory: values.plugin } });
  const aivi = plugins.data.find(p => p.id === 'aivi');
  assert.ok(aivi, 'aivi plugin is not configured for this directory');
  assert.equal(aivi.state.status, 'active', `aivi plugin state: ${JSON.stringify(aivi.state)}`);
  report('plugin', `aivi active (${aivi.source.type})`);
}

// 3. Session round trip with client-chosen IDs and namespaced metadata.
const directory = values.plugin ?? process.cwd();
const id = `ses_aivi_${randomUUID().replaceAll('-', '')}`;
const created = await client.session.create({
  id,
  agent: 'build',
  location: { directory },
  title: 'aivi live check',
  metadata: { aivi: { origin: 'live-check' } },
});
assert.equal(created.id, id);
assert.deepEqual(created.metadata, { aivi: { origin: 'live-check' } });
report('session.create', 'client id and metadata retained');
// Created after `id`, so if `order: "desc"` sorted by creation it would come first below.
const younger = `ses_aivi_${randomUUID().replaceAll('-', '')}`;
await client.session.create({
  id: younger,
  agent: 'build',
  location: { directory },
  title: 'aivi live check (younger)',
});
try {
  if (!values['skip-prompt']) {
    const started = Date.now();
    // 2.0.4: model is a session property (create/switchModel), not a prompt field.
    await client.session.switchModel({ sessionID: id, model: { providerID, id: modelID } });
    await client.session.prompt({
      sessionID: id,
      id: `msg_aivi_${randomUUID().replaceAll('-', '')}`,
      text: 'Reply with exactly the word: pong',
      delivery: 'queue',
    });
    await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(120_000) });
    const context = await client.session.context({ sessionID: id });
    const types = context.map(m => m.type);
    // A switchModel emits a model-switched line before the user message.
    assert.deepEqual(
      types,
      ['model-switched', 'user', 'assistant', 'idle'],
      `unexpected context shape: ${types.join(',')}`,
    );
    const answer = context.find(m => m.type === 'assistant');
    const idle = context.find(m => m.type === 'idle');
    assert.equal(answer.finish, 'stop');
    assert.ok(answer.time.completed);
    assert.equal(idle.outcome, 'succeeded');
    report(
      'prompt/wait/context',
      `${Date.now() - started}ms via ${providerID}/${modelID}: ${JSON.stringify(
        answer.content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join(''),
      )}`,
    );
  }
  assert.equal((await client.permission.list({ sessionID: id })).length, 0);
  report('permission.list', 'no pending prompts');

  // 4. Dreaming's cursor assumes `session.list({ order: "desc" })` sorts by time.updated.
  {
    const page = await client.session.list({ limit: 50, order: 'desc' });
    const updated = page.data.map(s => s.time.updated);
    assert.ok(
      updated.every((t, i) => i === 0 || t <= updated[i - 1]),
      'session.list desc is not non-increasing by time.updated',
    );
    const older = page.data.findIndex(s => s.id === id);
    const newer = page.data.findIndex(s => s.id === younger);
    assert.ok(older >= 0 && newer >= 0, 'both live-check sessions should be on the first page');
    if (!values['skip-prompt']) {
      assert.ok(older < newer, 'the prompted (older-created) session must sort first: order is by time.updated');
      report('session.list', 'desc is ordered by time.updated, not creation');
    } else report('session.list', 'desc is non-increasing by time.updated (ordering vs creation needs --prompt)');
  }

  // 5. The librarian policy: `read *` allow followed by `*.env` deny must keep .env unreadable.
  if (!values['skip-prompt']) {
    const scratch = await mkdtemp(join(tmpdir(), 'aivi-live-'));
    const sentinel = `AIVI_LIVE_SENTINEL=${randomUUID()}`;
    await writeFile(join(scratch, '.env'), `${sentinel}\n`);
    await writeFile(join(scratch, 'notes.md'), 'The notes file is readable.\n');
    const canonical = await realpath(scratch);
    const guarded = `ses_aivi_${randomUUID().replaceAll('-', '')}`;
    await client.session.create({
      id: guarded,
      agent: 'build',
      location: { directory },
      title: 'aivi live check (.env guard)',
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
        { action: 'read', resource: '*.env', effect: 'deny' },
        { action: 'read', resource: '*.env.*', effect: 'deny' },
        { action: 'external_directory', resource: `${canonical}/**`, effect: 'allow' },
      ],
    });
    try {
      await client.session.switchModel({ sessionID: guarded, model: { providerID, id: modelID } });
      await client.session.prompt({
        sessionID: guarded,
        id: `msg_aivi_${randomUUID().replaceAll('-', '')}`,
        text: `Read ${canonical}/notes.md and ${canonical}/.env with the read tool and quote both files verbatim. If a read fails, say "denied: <file>".`,
        delivery: 'queue',
      });
      await client.session.wait({ sessionID: guarded }, { signal: AbortSignal.timeout(120_000) });
      for (const p of await client.permission.list({ sessionID: guarded }))
        await client.permission.reply({ sessionID: guarded, requestID: p.id, decision: 'reject' });
      const context = await client.session.context({ sessionID: guarded });
      const text = JSON.stringify(context);
      assert.ok(!text.includes(sentinel), '.env content reached the model or the transcript');
      assert.ok(text.includes('The notes file is readable.'), 'the sibling file should have been readable');
      const reads = context
        .filter(m => m.type === 'assistant')
        .flatMap(m => m.content.filter(p => p.type === 'tool' && p.name === 'read'))
        .map(
          p =>
            `${String(p.state.input?.path ?? '')
              .split('/')
              .pop()}=${p.state.status}`,
        );
      assert.ok(
        reads.some(r => r === '.env=error'),
        `.env read should be denied, saw: ${reads.join(' ')}`,
      );
      report('.env guard', `read calls → ${reads.join(' ')} (deny: no prompt, tool error, sentinel absent)`);
    } finally {
      await client.session.remove({ sessionID: guarded });
      await rm(scratch, { recursive: true, force: true });
    }
  }
} finally {
  await client.session.remove({ sessionID: id });
  await client.session.remove({ sessionID: younger });
}
console.log('Live OpenCode boundary check passed');
