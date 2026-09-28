/** The host's command surface on a bare commander tree — exactly what the
 *  `@aivi/cli` bin collects. The host parses no argv of its own (it boots via
 *  `dist/server.js`), so anything that wants argv behavior out of the command
 *  surface — the host tests and the smoke — spawns this instead of a bin. It
 *  lives under the host's own tree so `commander` resolves to the version the
 *  host pins, not whatever the repo root hoists. Resolution follows the
 *  caller: under `--conditions=development` (inherited through NODE_OPTIONS by
 *  `npm test`) it drives the sources; plain node gets the built `dist/cli.js`.
 *  Not a `*.test.ts` file, so `node --test` never runs it as a test. */

import { registerCommands } from '@aivi/host/cli';
import { Command, CommanderError } from 'commander';

const program = new Command('aivi');
await registerCommands(program);
try {
  await program.parseAsync(process.argv.slice(2), { from: 'user' });
} catch (error) {
  if (error instanceof CommanderError) {
    // Commander has written its message already; showing help or the version is success.
    process.exitCode =
      error.code === 'commander.help' || error.code === 'commander.helpDisplayed' || error.code === 'commander.version'
        ? 0
        : error.exitCode;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
