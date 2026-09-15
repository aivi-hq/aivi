// Live OpenCode v2 boundary check. Requires a running `opencode service` and, for
// the prompt step, a configured provider. Not part of `npm run check`.
//
//   node scripts/live-opencode.mjs                       # discovery + auth + session round trip
//   node scripts/live-opencode.mjs --plugin DIR          # also assert the aivi plugin is active for DIR
//   MODEL=github-copilot/gemini-3.8-flash node scripts/live-opencode.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { OpenCode } from '@opencode/client';
import { Service } from '@opencode/client/service';

const { values } = parseArgs({ options: { plugin: { type: 'string' }, 'skip-prompt': { type: 'boolean' } } });
// Provider ids may themselves contain '/', so split on the first one only.
const model = process.env.MODEL ?? 'github-copilot/gemini-3.8-flash';
const providerID = model.slice(0, model.indexOf('/'));
const modelID = model.slice(model.indexOf('/') + 1);
const report = (name, detail) => console.log(`ok  ${name}${detail ? `  ${detail}` : ''}`);

// 1. Discovery and authentication. Verified on 2.0.3: basic auth only, bearer -> 401.
const endpoint = await Service.discover();
assert.ok(endpoint, 'No running OpenCode service; run `opencode service start`');
report('discover', `${endpoint.url} auth=${endpoint.auth?.type ?? 'none'}`);
if (endpoint.auth) {
  assert.equal((await fetch(`${endpoint.url}/api/health`)).status, 401);
  assert.equal(
    (await fetch(`${endpoint.url}/api/health`, { headers: { authorization: `Bearer ${endpoint.auth.password}` } }))
      .status,
    401,
  );
  report('auth', 'anonymous and bearer rejected, basic accepted');
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
const health = await client.health.get();
assert.equal(health.healthy, true);
report('health', `version=${health.version}`);

// 2. Plugin activation for a directory (optional).
if (values.plugin) {
  await client.plugin.awaitActivation({ location: { directory: values.plugin } });
  const plugins = await client.plugin.list({ location: { directory: values.plugin } });
  const aivi = plugins.data.find(p => p.id === 'aivi');
  assert.ok(aivi, 'aivi plugin is not configured for this directory');
  assert.equal(aivi.state.status, 'active', `aivi plugin state: ${JSON.stringify(aivi.state)}`);
  report('plugin', `aivi active from ${aivi.source.path ?? aivi.source.type}`);
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
try {
  if (!values['skip-prompt']) {
    const started = Date.now();
    await client.session.prompt({
      sessionID: id,
      id: `msg_aivi_${randomUUID().replaceAll('-', '')}`,
      text: 'Reply with exactly the word: pong',
      delivery: 'queue',
      model: { providerID, modelID },
    });
    await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(120_000) });
    const context = await client.session.context({ sessionID: id });
    const types = context.map(m => m.type);
    assert.deepEqual(types, ['user', 'assistant', 'idle'], `unexpected context shape: ${types.join(',')}`);
    const answer = context[1];
    const idle = context[2];
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
} finally {
  await client.session.remove({ sessionID: id });
}
console.log('Live OpenCode boundary check passed');
