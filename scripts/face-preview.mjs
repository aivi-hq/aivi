/* Render the face at scanline densities so a human can judge the look
   (docs/plans/voice-ship.md item 9b). Uses @aivi/chrome — the same route a
   meeting takes, standalone mode. Output: tmp/face-scan<N>.png plus
   tmp/face-default.png. Usage:
   node --conditions=development scripts/face-preview.mjs [density...] */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chrome } from '@aivi/chrome';

const root = import.meta.dirname;
const densities = process.argv
  .slice(2)
  .map(Number)
  .filter(n => n > 0);
const counts = densities.length ? densities : [6, 12, 24];
const out = join(root, '..', 'tmp');
const profile = await mkdtemp(join(tmpdir(), 'aivi-face-preview-'));

const chrome = await Chrome.launch({ profileDir: profile, args: ['--window-size=640,480'] });
try {
  const tab = await chrome.newTab();
  await tab.goto(`file://${join(root, '..', 'packages', 'core', 'face', 'index.html')}`);
  await tab.waitFor(() => typeof window.aiviFace === 'object');
  const settle = () => new Promise(r => setTimeout(r, 400)); // a few frames of the new look
  for (const n of [...counts, 0]) {
    await tab.call(k => window.aiviFace.crt({ scanlineCount: k }), n);
    await settle();
    const file = join(out, n === 0 ? 'face-default.png' : `face-scan${n}.png`);
    await writeFile(file, await tab.screenshot());
    console.log(file);
  }
} finally {
  await chrome.close();
  await rm(profile, { recursive: true, force: true });
}
