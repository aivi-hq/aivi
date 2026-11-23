/** The functions that run inside the Meet page. Their one collaborator is the
 *  page: each test sets `document` and `location` to object literals holding
 *  only what the function under test reads. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { element, inPage } from '../../chrome/test/in-page.ts';
import { leaveGone, lookAtScreen, muteSays, titleOfPage } from '../src/page.ts';

test('lookAtScreen reads the address, the words, and every button with its name and whether it takes a click', t => {
  const querySelectorAll = t.mock.fn(() => [
    element(t, { text: ' Ask to join ' }),
    element(t, { text: 'x', attributes: { 'aria-label': 'Turn off microphone' } }),
    element(t, { text: 'Present now', disabled: true }),
    element(t, { text: 'Chat', attributes: { 'aria-disabled': 'true' } }),
    element(t, { tag: 'DIV' }),
  ]);
  inPage(t, {
    document: { body: { innerText: 'Ready to join?', textContent: 'Ready to join? (hidden)' }, querySelectorAll },
    location: { href: 'https://meet.google.com/abc-defg-hij' },
  });

  assert.deepEqual(lookAtScreen(), {
    url: 'https://meet.google.com/abc-defg-hij',
    words: 'Ready to join?',
    buttons: [
      { name: 'Ask to join', enabled: true },
      { name: 'Turn off microphone', enabled: true },
      { name: 'Present now', enabled: false },
      { name: 'Chat', enabled: false },
      { name: '', enabled: true },
    ],
  });
  assert.deepEqual(querySelectorAll.mock.calls[0]?.arguments, ['button, [role="button"]']);
});

test('lookAtScreen falls back to the text content, and reads no words without a body', t => {
  for (const [body, words] of [
    [{ innerText: '', textContent: 'only content' }, 'only content'],
    [{ innerText: '', textContent: '' }, ''],
    [null, ''],
  ] as const) {
    inPage(t, { document: { body, querySelectorAll: () => [] }, location: { href: 'https://meet.google.com/x' } });

    assert.equal(lookAtScreen().words, words);
  }
});

test('titleOfPage reads the title of the document', t => {
  inPage(t, { document: { title: 'Meet - abc-defg-hij' } });

  assert.equal(titleOfPage(), 'Meet - abc-defg-hij');
});

test('leaveGone is false while an enabled button says leave, however the page words it', t => {
  for (const options of [
    { text: 'Leave call' },
    { text: 'x', attributes: { 'aria-label': 'Leave meeting' } },
    { text: '  Hang up ' },
  ]) {
    inPage(t, { document: { querySelectorAll: () => [element(t, { text: 'Chat' }), element(t, options)] } });

    assert.equal(leaveGone(), false, JSON.stringify(options));
  }
});

test('leaveGone is true when there is no leave button, or it is disabled', t => {
  inPage(t, { document: { querySelectorAll: () => [element(t, { text: 'Chat' }), element(t)] } });
  assert.equal(leaveGone(), true);

  inPage(t, { document: { querySelectorAll: () => [element(t, { text: 'Leave call', disabled: true })] } });
  assert.equal(leaveGone(), true);
});

test('muteSays is true only when the first mute button says that value about itself', t => {
  const querySelector = t.mock.fn((selector: string) =>
    selector === 'button[data-is-muted]' ? { getAttribute: () => 'true' } : null,
  );
  inPage(t, { document: { querySelector } });

  assert.equal(muteSays('true'), true);
  assert.equal(muteSays('false'), false);

  inPage(t, { document: { querySelector: () => null } });
  assert.equal(muteSays('true'), false);
});
