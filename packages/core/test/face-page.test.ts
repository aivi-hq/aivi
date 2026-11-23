/** The functions that run inside the face page. Their one collaborator is the
 *  page: each test sets `window` to an object literal holding only what the
 *  function under test reaches. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inPage } from '../../chrome/test/in-page.ts';
import { faceIsUp, playWav, setFace, setFaceWith, setTapOn, stopAllVoice } from '../src/face-page.ts';

test('faceIsUp is true once the face script has put its object on the page', t => {
  inPage(t, { window: {} });
  assert.equal(faceIsUp(), false);

  inPage(t, { window: { aiviFace: { setState: () => {} } } });
  assert.equal(faceIsUp(), true);
});

test('setFace and setFaceWith hand the state to the face, with the detail only when there is one', t => {
  const setState = t.mock.fn();
  inPage(t, { window: { aiviFace: { setState } } });

  setFace('listening');
  setFaceWith('tool', { name: 'search' });

  assert.deepEqual(
    setState.mock.calls.map(call => call.arguments),
    [['listening'], ['tool', { name: 'search' }]],
  );
});

test('the face calls do nothing, and do not throw, before the face is up', t => {
  inPage(t, { window: {} });

  assert.equal(setFace('listening'), undefined);
  assert.equal(setFaceWith('tool', {}), undefined);
});

test('playWav hands the wav to the page microphone and answers what it answers; stopAllVoice stops it', t => {
  const play = t.mock.fn((_b64: string) => true);
  const stopAll = t.mock.fn();
  inPage(t, { window: { __aiviMic: { play, stopAll } } });

  assert.equal(playWav('UklGRg=='), true);
  stopAllVoice();

  assert.deepEqual(
    play.mock.calls.map(call => call.arguments),
    [['UklGRg==']],
  );
  assert.equal(stopAll.mock.callCount(), 1);
});

test('setTapOn switches the tap and tells the page to silence its speakers, or not', t => {
  const mute = t.mock.fn();
  const page: Record<string, unknown> = { __aiviMute: mute };
  inPage(t, { window: page });

  setTapOn(true, true);
  assert.equal(page.__aiviTap, true);
  setTapOn(false, false);

  assert.equal(page.__aiviTap, false);
  assert.deepEqual(
    mute.mock.calls.map(call => call.arguments),
    [[true], [false]],
  );
});

test('setTapOn switches the tap when the page has no way to mute yet', t => {
  const page: Record<string, unknown> = {};
  inPage(t, { window: page });

  setTapOn(true, true);

  assert.equal(page.__aiviTap, true);
});
