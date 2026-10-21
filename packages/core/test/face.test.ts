/** The face: install/read (prompts pattern, filesystem only) and the
 *  injection as a string — shim first, then the face's script. The browser
 *  routes themselves are not tested here: by ruling (2026-10-13) the suite
 *  launches no Chrome. The lab (`/private/var/folders/.../meet-join/`) and
 *  the operator's real meeting are the standing evidence that the shim
 *  answers devices with the face and the audio flows both ways. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  defaultFaceHtml,
  faceInjection,
  faceScriptSource,
  installFace,
  MEDIA_SHIM,
  readFaceHtml,
} from '../src/index.ts';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aivi-face-home-'));
}

test('install copies once, never overwrites; delete restores the built-in', async () => {
  const home = await tempHome();
  try {
    assert.deepEqual(await installFace(home), { written: true, kept: false });
    assert.ok(existsSync(join(home, 'face', 'index.html')));
    assert.deepEqual(await installFace(home), { written: false, kept: true });

    // the operator's own face is what reads back, header stripped
    const operatorFace = '<!doctype html><html><body><script>window.aiviFace={canvas:null};</script></body></html>';
    await writeFile(join(home, 'face', 'index.html'), operatorFace);
    assert.equal(await readFaceHtml(home), operatorFace);

    // delete: instant restoration
    await rm(join(home, 'face', 'index.html'));
    assert.equal(await readFaceHtml(home), await defaultFaceHtml());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the script extraction finds the face and says so when there is none', async () => {
  const builtIn = await defaultFaceHtml();
  const script = faceScriptSource(builtIn);
  assert.ok(script.includes('window.aiviFace'));
  assert.ok(script.includes('aiviFace.canvas') || script.includes('canvas: view'));
  assert.throws(() => faceScriptSource('<html><body>no face here</body></html>'), /no inline <script>/);
  assert.throws(() => faceScriptSource('<html><script src="elsewhere.js"></script></html>'), /no inline <script>/);

  const home = await tempHome();
  try {
    const injection = await faceInjection(home);
    assert.ok(injection.startsWith(MEDIA_SHIM));
    assert.ok(injection.includes(script));
    // the media verbs the meeting pages and core both speak
    for (const verb of ['__aiviMic', 'stopAll', '__aiviTap', '__aiviAudio', '__aiviMute', 'aivi-mic (aivi)'])
      assert.ok(MEDIA_SHIM.includes(verb), `the shim lost its word for ${verb}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
