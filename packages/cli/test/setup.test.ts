import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TICKET_TOOL_ACTIONS } from '@aivi/plugin';
import { loadClientConfig, saveClientConfig } from '../src/client-config.ts';
import { extractSetupFlags, seedHomeOpenCode, setup } from '../src/setup.ts';
import {
  cancelSetup,
  hostUrl,
  interactiveSetup,
  modelDefaults,
  setupClock,
  setupFixture,
  setupPrompts,
  TOKEN,
} from './setup-fixture.ts';

test('setup parses both valued flag forms and refuses unknown or missing flags', () => {
  for (const equals of [false, true]) {
    const values = {
      '--host-package': '@aivi/host@0.2.0',
      '--use': 'another',
      '--url': 'http://h:1',
      '--token': TOKEN,
      '--name': 'Ada',
      '--public': 'https://aivi.example',
    };
    const args = Object.entries(values).flatMap(([name, value]) => (equals ? [`${name}=${value}`] : [name, value]));
    assert.deepEqual(extractSetupFlags(args), {
      hostPackage: values['--host-package'],
      use: 'another',
      connect: false,
      url: 'http://h:1',
      token: TOKEN,
      name: 'Ada',
      public: 'https://aivi.example',
    });
  }
  assert.equal(extractSetupFlags(['--connect']).connect, true);
  assert.throws(() => extractSetupFlags(['--wat']), /Unknown setup flag/);
  assert.throws(() => extractSetupFlags(['--url']), /wants a value/);
});

test('setup validates conflicting branches and unknown machine kinds before any effect', async t => {
  const h = setupFixture(t);
  await assert.rejects(setup(['--connect', '--use', 'this-machine'], { home: h.home }, h.io), /different branches/);
  await assert.rejects(setup(['--use', 'elsewhere'], { home: h.home }, h.io), /Unknown --use elsewhere/);
  assert.equal(existsSync(h.home), false);
  assert.equal(h.install.mock.callCount(), 0);
  assert.equal(h.health.mock.callCount(), 0);
});

test('connect waits for health and identity proof before saving a person or adding plugins', async t => {
  const h = setupFixture(t);
  const probing = Promise.withResolvers<void>();
  const healthy = Promise.withResolvers<boolean>();
  const identifying = Promise.withResolvers<void>();
  const identity = Promise.withResolvers<typeof h.who>();
  h.health.mock.mockImplementation(async url => {
    assert.equal(url, hostUrl);
    probing.resolve();
    return healthy.promise;
  });
  h.whoami.mock.mockImplementation(async (url, token) => {
    assert.equal(url, hostUrl);
    assert.equal(token, TOKEN);
    identifying.resolve();
    return identity.promise;
  });

  const connecting = setup(['--connect', '--url', hostUrl, '--token', TOKEN], { home: h.home }, h.io);
  await probing.promise;
  assert.equal(loadClientConfig(), undefined);
  assert.equal(h.whoami.mock.callCount(), 0);
  healthy.resolve(true);
  await identifying.promise;
  assert.equal(loadClientConfig(), undefined);
  assert.equal(h.pluginAdd.mock.callCount(), 0);
  identity.resolve(h.who);
  await connecting;

  assert.deepEqual(loadClientConfig()?.person, { token: TOKEN, ...h.who.person, roles: h.who.roles });
  assert.equal(loadClientConfig()?.url, hostUrl);
  assert.deepEqual(
    h.pluginAdd.mock.calls.map(call => call.arguments),
    [['@aivi/opencode'], ['opencode-attribution']],
  );
  assert.equal(h.install.mock.callCount(), 0);
  assert.match(h.log.mock.calls.at(-1)!.arguments[0], /Signed in as Ada/);
});

test('connection failures preserve the existing client record and never install plugins', async t => {
  for (const phase of ['health', 'whoami'] as const) {
    await t.test(phase, async t => {
      const h = setupFixture(t);
      saveClientConfig({ url: 'http://old:4100', home: '/old-home', person: { token: TOKEN, name: 'Old name' } });
      const before = readFileSync(h.clientPath, 'utf8');
      if (phase === 'health') h.health.mock.mockImplementation(async () => false);
      else
        h.whoami.mock.mockImplementation(async () => {
          throw new Error('invalid bearer');
        });

      await assert.rejects(
        setup(['--connect', '--url', hostUrl, '--token', 'new-bearer'], { home: h.home }, h.io),
        phase === 'health' ? /No answer from/ : /invalid bearer/,
      );

      assert.equal(readFileSync(h.clientPath, 'utf8'), before);
      assert.equal(h.pluginAdd.mock.callCount(), 0);
      assert.equal(h.install.mock.callCount(), 0);
    });
  }
});

test('connect reuses the saved URL but asks for a fresh bearer', async t => {
  const h = setupFixture(t);
  saveClientConfig({ url: hostUrl, person: { token: 'old-bearer' } });
  h.ask.token.mock.mockImplementation(async () => TOKEN);

  await setup(['--connect'], { home: h.home }, h.io);

  assert.equal(h.ask.url.mock.callCount(), 0);
  assert.equal(h.ask.token.mock.callCount(), 1);
  assert.deepEqual(h.whoami.mock.calls[0]!.arguments, [hostUrl, TOKEN]);
});

test('an unreachable host does not create a fresh client record or add plugins', async t => {
  const h = setupFixture(t);
  h.health.mock.mockImplementation(async () => false);

  await assert.rejects(
    setup(['--connect', '--url', hostUrl, '--token', TOKEN], { home: h.home }, h.io),
    /No answer from/,
  );

  assert.equal(loadClientConfig(), undefined);
  assert.equal(h.whoami.mock.callCount(), 0);
  assert.equal(h.pluginAdd.mock.callCount(), 0);
});

test('an unsigned machine follows the selected connect branch and asks only for missing values', async t => {
  const h = setupFixture(t);
  h.ask.branch.mock.mockImplementation(async () => 'connect');
  h.ask.url.mock.mockImplementation(async () => hostUrl);
  h.ask.token.mock.mockImplementation(async () => TOKEN);

  await setup([], { home: h.home }, h.io);

  assert.equal(h.ask.branch.mock.callCount(), 1);
  assert.equal(h.ask.url.mock.callCount(), 1);
  assert.equal(h.ask.token.mock.callCount(), 1);
  assert.equal(h.createIdentity.mock.callCount(), 0);
  assert.equal(loadClientConfig()?.person?.id, h.identity.person);
});

test('a signed-in machine refreshes the display cache without replacing its installation record', async t => {
  const h = setupFixture(t);
  saveClientConfig({
    home: h.home,
    appDir: h.appDir,
    nodePath: '/managed/node',
    url: hostUrl,
    person: { token: TOKEN },
  });

  await setup([], { home: h.home }, h.io);

  assert.deepEqual(loadClientConfig(), {
    configVersion: 1,
    home: h.home,
    appDir: h.appDir,
    nodePath: '/managed/node',
    url: hostUrl,
    person: { token: TOKEN, ...h.who.person, roles: ['operator'] },
  });
  assert.equal(h.ask.branch.mock.callCount(), 0);
  assert.equal(h.createIdentity.mock.callCount(), 0);
});

test('a locally installed server supplies its URL instead of prompting for another host', async t => {
  for (const [bind, expected] of [
    [undefined, hostUrl],
    ['0.0.0.0', hostUrl],
    ['::', hostUrl],
    ['[::]', hostUrl],
    ['10.0.0.3', 'http://10.0.0.3:4100'],
    ['2001:db8::1', 'http://[2001:db8::1]:4100'],
    ['[2001:db8::1]', 'http://[2001:db8::1]:4100'],
  ] as const) {
    await t.test(String(bind), async t => {
      const h = setupFixture(t);
      mkdirSync(join(h.appDir, 'node_modules', '@aivi', 'host'), { recursive: true });
      h.config({ version: 1, ...(bind ? { host: { bind } } : {}) });
      h.ask.token.mock.mockImplementation(async () => TOKEN);

      await setup([], { home: h.home }, h.io);

      assert.equal(loadClientConfig()?.url, expected);
      assert.deepEqual(h.health.mock.calls[0]!.arguments, [expected]);
      assert.equal(h.ask.branch.mock.callCount(), 0);
      assert.equal(h.ask.url.mock.callCount(), 0);
      assert.equal(h.install.mock.callCount(), 0);
      assert.equal(loadClientConfig()?.home, undefined);
    });
  }
});

test('a missing or unreadable local config asks for the host URL rather than reinstalling', async t => {
  for (const unreadable of [false, true]) {
    await t.test(unreadable ? 'invalid JSON' : 'missing file', async t => {
      const h = setupFixture(t);
      mkdirSync(join(h.appDir, 'node_modules', '@aivi', 'host'), { recursive: true });
      if (unreadable) writeFileSync(h.configPath, '{broken');
      h.ask.url.mock.mockImplementation(async () => 'http://repaired:4300');
      h.ask.token.mock.mockImplementation(async () => TOKEN);

      await setup([], { home: h.home }, h.io);

      assert.equal(loadClientConfig()?.url, 'http://repaired:4300');
      assert.equal(h.ask.branch.mock.callCount(), 0);
      assert.equal(h.ask.url.mock.callCount(), 1);
      assert.equal(h.install.mock.callCount(), 0);
    });
  }
});

test('scripted creation seeds a private home and installs only the requested server', async t => {
  const h = setupFixture(t);

  await setup(
    ['--use=this-machine', '--name=Ada', '--host-package=@aivi/host@0.2.0'],
    { home: h.home, nodePath: '/node' },
    h.io,
  );

  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')), { version: 1 });
  assert.equal(statSync(join(h.home, '.env')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(h.appDir, '.npmrc')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(h.appDir, 'package.json'), 'utf8')), {
    name: 'aivi-server',
    private: true,
  });
  assert.deepEqual(h.install.mock.calls[0]!.arguments, [['@aivi/host@0.2.0'], h.appDir]);
  assert.deepEqual(h.rebuildSchema.mock.calls[0]!.arguments, [h.home, h.appDir]);
  assert.deepEqual(h.createIdentity.mock.calls[0]!.arguments, [{ use: 'this-machine', name: 'Ada' }, h.home, h.appDir]);
  const seeded = readFileSync(join(h.home, 'opencode.jsonc'), 'utf8');
  assert.match(seeded, /"@aivi\/opencode@9\.9\.9"/);
  assert.match(seeded, /"action": "aivi_ticket_\*", "resource": "\*", "effect": "deny"/);
  for (const action of TICKET_TOOL_ACTIONS) assert.ok(action.startsWith('aivi_ticket_'));
  for (const agent of ['assistant', 'dreamer', 'product', 'dev', 'review', 'voice-assistant'])
    assert.equal(existsSync(join(h.home, '.opencode', 'agents', `${agent}.md`)), true);
  assert.match(
    readFileSync(join(h.home, '.opencode', 'agents', 'assistant.md'), 'utf8'),
    /you do not perform\nproject work/,
  );
  assert.match(readFileSync(join(h.home, '.opencode', 'agents', 'dev.md'), 'utf8'), /both use aivi_respond_feedback/);
  assert.match(
    readFileSync(join(h.home, '.opencode', 'agents', 'review.md'), 'utf8'),
    /Request changes for problems\.\s+Comments for nits\./,
  );
  assert.equal(loadClientConfig()?.nodePath, '/node');
  assert.equal(loadClientConfig()?.installMethod, 'npm');
  assert.equal(loadClientConfig()?.person?.token, TOKEN);
  assert.equal(h.loadKnowledge.mock.callCount(), 0);
  assert.equal(h.serviceInstall.mock.callCount(), 0);
  assert.equal(h.health.mock.callCount(), 0);
  assert.equal(h.ask.background.mock.callCount(), 0);
  assert.match(h.log.mock.calls.at(-1)!.arguments[0], /Next: `aivi serve`/);
});

test('setup preserves existing home files, including the operator’s npm configuration', async t => {
  const h = setupFixture(t);
  const files = {
    'config.json': '{"version":1,"search":false,"custom":true}\n',
    '.env': 'SECRET=kept\n',
    'app/.npmrc': 'registry=https://registry.example/\nsave-exact=true\n',
    'app/package.json': '{"name":"kept","private":true}\n',
    'opencode.jsonc': '{"kept":true}\n',
    '.opencode/agents/assistant.md': 'custom assistant\n',
  };
  mkdirSync(join(h.home, '.opencode', 'agents'), { recursive: true });
  mkdirSync(h.appDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(h.home, path), content);

  await setup(['--use=this-machine', '--name=Ada'], { home: h.home }, h.io);

  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(join(h.home, path), 'utf8'), content);
  assert.equal(existsSync(join(h.home, '.opencode', 'agents', 'dreamer.md')), true);
  assert.equal(h.loadKnowledge.mock.callCount(), 0);
});

test('headless creation prints the identity caveat and handoff without signing this machine in', async t => {
  const h = setupFixture(t);
  h.createIdentity.mock.mockImplementation(async () => ({
    ...h.identity,
    urlNote: 'Only this LAN can reach the URL.',
  }));

  await setup(['--use=another', '--public=https://aivi.example'], { home: h.home }, h.io);

  assert.deepEqual(h.createIdentity.mock.calls[0]!.arguments[0], {
    use: 'another',
    name: 'Operator',
    public: 'https://aivi.example',
  });
  assert.equal(loadClientConfig()?.person, undefined);
  assert.equal(h.pluginAdd.mock.callCount(), 0);
  assert.equal(h.loadKnowledge.mock.callCount(), 0);
  assert.equal(h.serviceInstall.mock.callCount(), 0);
  assert.equal(h.warn.mock.calls[0]!.arguments[0], 'Only this LAN can reach the URL.');
  const output = h.log.mock.calls.map(call => call.arguments[0]).join('\n');
  assert.match(output, new RegExp(TOKEN));
  assert.match(output, /Connect to a host/);
});

test('interactive creation passes the selected reach into identity and respects a declined background service', async t => {
  for (const reach of [
    { kind: 'none' },
    { kind: 'lan', bind: '10.0.0.3' },
    { kind: 'url', url: 'https://aivi.example' },
  ] as const) {
    await t.test(reach.kind, async t => {
      const h = interactiveSetup(t);
      h.ask.reach.mock.mockImplementation(async () => reach);

      await setup([], { home: h.home }, h.io);

      const address =
        reach.kind === 'lan' ? { lanBind: reach.bind } : reach.kind === 'url' ? { public: reach.url } : {};
      assert.deepEqual(h.createIdentity.mock.calls[0]!.arguments[0], { use: 'this-machine', name: 'Ada', ...address });
      assert.deepEqual(h.ask.models.mock.calls[0]!.arguments, [modelDefaults]);
      assert.equal(h.ask.reach.mock.callCount(), 1);
      assert.equal(h.ask.background.mock.callCount(), 1);
      assert.equal(h.warmHome.mock.callCount(), 0);
      assert.equal(h.serviceInstall.mock.callCount(), 0);
    });
  }
});

test('creation on an unsupported Node major stops before making a home or asking a question', async t => {
  const h = setupFixture(t);
  t.mock.property(process.versions, 'node', '27.0.0');

  await assert.rejects(setup(['--use=another'], { home: h.home }, h.io), /aivi needs Node 26.*27\.0\.0/);

  assert.equal(existsSync(h.home), false);
  assert.equal(h.createIdentity.mock.callCount(), 0);
});

test('an install failure stops before recording an installation or minting identity', async t => {
  const h = setupFixture(t);
  h.install.mock.mockImplementation(() => {
    throw new Error('npm refused');
  });

  await assert.rejects(setup(['--use=another'], { home: h.home }, h.io), /npm refused/);

  assert.equal(loadClientConfig(), undefined);
  assert.equal(h.rebuildSchema.mock.callCount(), 0);
  assert.equal(h.createIdentity.mock.callCount(), 0);
});

test('schema and registry failures warn but do not prevent creation or invent a plugin version', async t => {
  for (const failure of [new Error('schema broken'), 'schema broken']) {
    await t.test(typeof failure, async t => {
      const h = setupFixture(t);
      h.rebuildSchema.mock.mockImplementation(async () => {
        throw failure;
      });
      h.npmView.mock.mockImplementation(async () => {
        throw new Error('offline');
      });

      await setup(['--use=another'], { home: h.home }, h.io);

      assert.equal(h.createIdentity.mock.callCount(), 1);
      assert.match(h.warn.mock.calls[0]!.arguments[0], /schema was not rebuilt \(schema broken\)/);
      assert.match(h.warn.mock.calls[1]!.arguments[0], /seeded the plugin unpinned/);
      assert.match(readFileSync(join(h.home, 'opencode.jsonc'), 'utf8'), /"plugins": \["@aivi\/opencode"\]/);
    });
  }
});

test('OpenCode missing from PATH leaves the verified sign-in intact and names both manual plugin commands', async t => {
  const h = setupFixture(t);
  h.opencodeOnPath.mock.mockImplementation(() => false);

  await setup(['--connect', '--url', hostUrl, '--token', TOKEN], { home: h.home }, h.io);

  assert.equal(loadClientConfig()?.person?.id, h.who.person.id);
  assert.equal(h.pluginAdd.mock.callCount(), 0);
  assert.match(
    h.warn.mock.calls[0]!.arguments[0],
    /opencode plugin add @aivi\/opencode.*opencode plugin add opencode-attribution/,
  );
});

test('named semantic models preserve the rest of search configuration and warm only after it is written', async t => {
  const h = interactiveSetup(t);
  h.config({ version: 1, search: { limit: 12, models: { embed: 'old-model' } } });
  h.ask.models.mock.mockImplementation(async () => ({ rerank: 'new-rerank' }));
  h.ask.fetchModels.mock.mockImplementation(async () => true);
  h.ask.capacity.mock.mockImplementation(async () => 3);
  h.warmHome.mock.mockImplementation(async () => {
    assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).search, {
      limit: 12,
      models: { rerank: 'new-rerank' },
    });
    return { models: modelDefaults, embedded: 7, seconds: 2 };
  });

  await setup([], { home: h.home }, h.io);

  assert.equal(h.warmHome.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).dispatcher, { pools: { default: { capacity: 3 } } });
  assert.ok(
    h.log.mock.calls.some(call => /Semantic models in place \(2s\); 7 chunks embedded/.test(call.arguments[0])),
  );
});

test('model defaults write nothing and a failed warm leaves keyword search available', async t => {
  for (const failure of [new Error('download failed'), 'download failed']) {
    await t.test(typeof failure, async t => {
      const h = interactiveSetup(t);
      h.config({ version: 1, dispatcher: { pools: { small: { capacity: 2 } } } });
      const before = readFileSync(h.configPath, 'utf8');
      h.ask.fetchModels.mock.mockImplementation(async () => true);
      h.warmHome.mock.mockImplementation(async () => {
        throw failure;
      });

      await setup([], { home: h.home }, h.io);

      assert.equal(readFileSync(h.configPath, 'utf8'), before);
      assert.equal(h.ask.capacity.mock.callCount(), 0);
      assert.match(h.warn.mock.calls[0]!.arguments[0], /models were not fetched \(download failed\).*keywords/);
      assert.match(h.log.mock.calls.at(-1)!.arguments[0], /Next: `aivi serve`/);
    });
  }
});

test('naming a semantic model creates only its search setting when no search block exists yet', async t => {
  const h = interactiveSetup(t);
  h.ask.models.mock.mockImplementation(async () => ({ embed: 'custom-embed' }));

  await setup([], { home: h.home }, h.io);

  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')), {
    version: 1,
    search: { models: { embed: 'custom-embed' } },
  });
  assert.equal(h.warmHome.mock.callCount(), 0);
});

test('disabled knowledge is not loaded and a capacity answer preserves dispatcher settings', async t => {
  const h = interactiveSetup(t);
  h.config({ version: 1, search: false, dispatcher: { idleMs: 4000, pools: {} } });
  h.ask.capacity.mock.mockImplementation(async () => 4);
  h.createIdentity.mock.mockImplementation(async () => ({
    home: h.home,
    url: hostUrl,
    person: h.identity.person,
    token: TOKEN,
  }));

  await setup([], { home: h.home }, h.io);

  assert.equal(h.loadKnowledge.mock.callCount(), 0);
  assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).dispatcher, {
    idleMs: 4000,
    pools: { default: { capacity: 4 } },
  });
  assert.deepEqual(loadClientConfig()?.person, { token: TOKEN });
});

test('background setup waits under a controlled clock and records only the identity whoami proves', async t => {
  const h = setupFixture(t, true);
  h.ask.background.mock.mockImplementation(async () => true);
  const waiting = setupClock(t);
  h.health.mock.mockImplementationOnce(async () => false);
  h.whoami.mock.mockImplementation(async () => ({
    person: { id: 'verified-id', name: 'Verified name' },
    roles: ['member'],
  }));

  const creating = setup(['--use=this-machine'], { home: h.home, nodePath: '/node' }, h.io);
  assert.equal(await waiting, 500);
  assert.deepEqual(h.serviceInstall.mock.calls[0]!.arguments, [{ home: h.home, appDir: h.appDir, nodePath: '/node' }]);
  assert.equal(h.whoami.mock.callCount(), 0);
  assert.deepEqual(loadClientConfig()?.person, { token: TOKEN });
  t.mock.timers.tick(500);
  await creating;

  assert.equal(h.health.mock.callCount(), 2);
  assert.deepEqual(h.whoami.mock.calls[0]!.arguments, [hostUrl, TOKEN]);
  assert.deepEqual(loadClientConfig()?.person, {
    token: TOKEN,
    id: 'verified-id',
    name: 'Verified name',
    roles: ['member'],
  });
  assert.match(h.log.mock.calls.at(-1)!.arguments[0], /Signed in as Verified name.*background/);
});

test('background setup that never becomes healthy fails at virtual time without claiming a sign-in', async t => {
  const h = setupFixture(t, true);
  h.ask.background.mock.mockImplementation(async () => true);
  h.health.mock.mockImplementation(async () => false);
  const waiting = setupClock(t);

  const creating = setup(['--use=this-machine'], { home: h.home }, h.io);
  const failed = assert.rejects(creating, /did not answer.*within 30 s.*service logs/);
  await waiting;
  t.mock.timers.tick(30_001);
  await failed;

  assert.equal(h.health.mock.callCount(), 2);
  assert.equal(h.whoami.mock.callCount(), 0);
  assert.deepEqual(loadClientConfig()?.person, { token: TOKEN });
  assert.ok(h.log.mock.calls.every(call => !call.arguments[0].startsWith('Signed in')));
});

test('a healthy background server with a rejected bearer cannot produce a verified sign-in', async t => {
  const h = setupFixture(t, true);
  h.ask.background.mock.mockImplementation(async () => true);
  h.whoami.mock.mockImplementation(async () => {
    throw new Error('bearer rejected');
  });

  await assert.rejects(setup(['--use=this-machine'], { home: h.home }, h.io), /bearer rejected/);

  assert.equal(h.serviceInstall.mock.callCount(), 1);
  assert.equal(h.health.mock.callCount(), 1);
  assert.equal(h.whoami.mock.callCount(), 1);
  assert.deepEqual(loadClientConfig()?.person, { token: TOKEN });
  assert.ok(h.log.mock.calls.every(call => !call.arguments[0].startsWith('Signed in')));
});

test('cancelling a prompt stops before the next effect and is distinct from a noninteractive invocation', async t => {
  for (const answer of [cancelSetup, undefined]) {
    await t.test(String(answer), async t => {
      const h = setupFixture(t);
      const prompts = setupPrompts(t, [answer]);
      h.io.ask = prompts.io.ask;

      await setup([], { home: h.home }, h.io);

      assert.equal(process.exitCode, 1);
      assert.equal(h.cancel.mock.callCount(), 1);
      assert.equal(existsSync(h.home), false);
      assert.equal(loadClientConfig(), undefined);
      assert.equal(h.health.mock.callCount(), 0);
    });
  }
});

test('setup without a terminal explains the scripted forms before writing anything', async t => {
  const h = setupFixture(t);

  await assert.rejects(
    setup([], { home: h.home }),
    /setup needs an interactive terminal; in a script use:.*--use .*--connect/,
  );

  assert.equal(existsSync(h.home), false);
  assert.equal(loadClientConfig(), undefined);
});

test('seeding fills missing agents without replacing the existing OpenCode config or agent', t => {
  const h = setupFixture(t);
  mkdirSync(join(h.home, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(h.home, 'opencode.jsonc'), '{"kept":true}');
  writeFileSync(join(h.home, '.opencode', 'agents', 'assistant.md'), 'custom');

  seedHomeOpenCode(h.home, '@aivi/opencode@1.0.0');

  assert.equal(readFileSync(join(h.home, 'opencode.jsonc'), 'utf8'), '{"kept":true}');
  assert.equal(readFileSync(join(h.home, '.opencode', 'agents', 'assistant.md'), 'utf8'), 'custom');
  for (const agent of ['dreamer', 'product', 'dev', 'review', 'voice-assistant'])
    assert.equal(existsSync(join(h.home, '.opencode', 'agents', `${agent}.md`)), true);
});
