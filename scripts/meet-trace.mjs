/** Join a meeting while a human watches: every step of the real production
 *  `driveJoin` state machine gets a numbered screenshot in
 *  `tmp/meet-trace/` (plus `final.txt` with the page's words), so the
 *  operator can see the whole flow after the fact — which screen Meet
 *  showed, which button got clicked, where it stopped.
 *
 *      node --conditions=development scripts/meet-trace.mjs https://meet.google.com/xxx-xxxx-xxx
 *
 *  It joins as a guest with the dev home's face and waits (long) for the
 *  host to admit — approve "aivi" in the meeting UI while it runs. This is
 *  eyes for debugging, not the production path (`aivi meet join` is). */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openFaceTab } from '@aivi/core';
import { driveJoin } from '@aivi/google-meet';

const url = process.argv[2];
if (!url) {
  console.error('usage: meet-trace.mjs <meet url>');
  process.exit(1);
}
const dir = 'tmp/meet-trace';
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

let n = 0;
const faceTab = await openFaceTab({ home: 'dev', stateDir: 'dev/state', url, hear: false, headless: false });
try {
  console.log('page sees webdriver =', await faceTab.tab.evaluate('String(navigator.webdriver)'));
  const joined = await driveJoin(faceTab.tab, {
    name: 'aivi',
    askTimeoutMs: 5 * 60_000, // the operator watches and admits by hand
    log: (msg, extra) => console.log('  ·', msg, JSON.stringify(extra ?? {})),
    onStep: async label => {
      const file = join(dir, `${String(++n).padStart(2, '0')}-${label.replace(/[^\w.-]+/g, '_')}.png`);
      await writeFile(file, await faceTab.tab.screenshot());
      console.log(`  ▸ ${label} -> ${file}`);
    },
  });
  console.log('JOINED', JSON.stringify(joined));
} catch (error) {
  console.log('ended:', String(error).slice(0, 240));
} finally {
  const words = await faceTab.tab.evaluate('document.body ? document.body.innerText : ""').catch(() => '');
  await writeFile(join(dir, 'final.txt'), String(words));
  await faceTab.close();
}
