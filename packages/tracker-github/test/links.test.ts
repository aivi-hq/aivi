import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '@aivi/host';
import { RunLinks } from '../src/links.ts';

const links = () => new RunLinks(new Store(':memory:'));

test('bind records the pair, and a replay of the same comment is not a second pair', () => {
  const l = links();
  l.bind('acme/shop#47:c1', 'acme/shop#47', 100);
  l.bind('acme/shop#47:c1', 'acme/shop#47', 200);
  assert.equal(l.byAgentSession('acme/shop#47:c1')?.ticketId, 'acme/shop#47');
});

test('attach joins the newest unattached pair, and a replay of the same session says nothing', () => {
  const l = links();
  l.bind('acme/shop#47:c1', 'acme/shop#47', 100);
  l.bind('acme/shop#47:c2', 'acme/shop#47', 200);
  assert.equal(l.attach('acme/shop#47', 'ses_run'), true);
  assert.equal(l.byAgentSession('acme/shop#47:c2')?.opencodeSession, 'ses_run', 'the newest pair takes it');
  assert.equal(l.attach('acme/shop#47', 'ses_run'), false, 'the same session is never attached twice');
  assert.equal(l.byAgentSession('acme/shop#47:c1')?.opencodeSession, undefined, 'the old pair is not stolen');
  assert.equal(l.byOpencodeSession('ses_run')?.agentSession, 'acme/shop#47:c2');
});

test('byTicket names the newest pair, settled or not — the follow-up route', () => {
  const l = links();
  l.bind('acme/shop#47:c1', 'acme/shop#47', 100);
  l.attach('acme/shop#47', 'ses_old');
  l.closingLanded('acme/shop#47:c1', 150);
  l.bind('acme/shop#47:c2', 'acme/shop#47', 200);
  l.attach('acme/shop#47', 'ses_new');
  assert.equal(l.byTicket('acme/shop#47')?.agentSession, 'acme/shop#47:c2');
});

test('owed lists the unattached closings only, oldest first, and settles on landing', () => {
  const l = links();
  l.bind('acme/shop#47:c1', 'acme/shop#47', 100); // no session yet: not owed, not readable
  l.bind('acme/shop#48:c2', 'acme/shop#48', 200);
  l.attach('acme/shop#48', 'ses_b');
  l.bind('acme/shop#49:c3', 'acme/shop#49', 300);
  l.attach('acme/shop#49', 'ses_c');
  assert.deepEqual(
    l.owed().map(o => o.agentSession),
    ['acme/shop#48:c2', 'acme/shop#49:c3'],
  );
  l.closingLanded('acme/shop#48:c2', 400);
  assert.deepEqual(
    l.owed().map(o => o.agentSession),
    ['acme/shop#49:c3'],
    'a settled pair is never asked again',
  );
});

test('drop retires a pair for good — the grave the closing was owed to', () => {
  const l = links();
  l.bind('acme/shop#47:c1', 'acme/shop#47', 100);
  l.attach('acme/shop#47', 'ses_x');
  l.drop('acme/shop#47:c1');
  assert.equal(l.byAgentSession('acme/shop#47:c1'), undefined);
  assert.deepEqual(l.owed(), []);
});
