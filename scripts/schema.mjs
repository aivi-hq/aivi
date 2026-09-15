// Generate JSON schemas from the Zod definitions. `--write` updates schemas/,
// `--check` fails when the checked-in files are stale (run by `npm run check`).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discordConfigSchema } from '@aivi/channel-discord';
import { slackConfigSchema } from '@aivi/channel-slack';
import { configSchema } from '@aivi/core';
import { z } from 'zod';

const targets = [
  ['schemas/aivi.schema.json', configSchema],
  ['schemas/discord.schema.json', discordConfigSchema],
  ['schemas/slack.schema.json', slackConfigSchema],
];
const mode = process.argv[2];
if (!['--write', '--check'].includes(mode)) {
  console.error('usage: schema.mjs --write | --check');
  process.exit(2);
}

let stale = 0;
for (const [relative, schema] of targets) {
  const path = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  // io: "input" describes what users may write: defaulted fields are optional.
  const json = `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }), null, 2)}\n`;
  const current = await readFile(path, 'utf8').catch(() => '');
  if (current === json) continue;
  if (mode === '--write') {
    await writeFile(path, json);
    console.log(`updated ${relative}`);
  } else {
    console.error(`stale: ${relative} (run npm run schema)`);
    stale++;
  }
}
if (stale) process.exit(1);
if (mode === '--check') console.log('schemas are current');
