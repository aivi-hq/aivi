/**
 * The setup `aivi install browser` runs: there is no platform account and no
 * secret — the whole decision is which Chrome aivi drives. The flow explains
 * the modes, writes the `browser` block into config.json, and never clobbers
 * a block that exists. Until this block exists the aivi browser is off: the
 * plugin never sees an `aivi_browser` tool.
 */
import { browserConfigSchema, type PluginSetup, type PluginSetupResult } from '@aivi/core';

const LAUNCH_BLOCK = { connection: { mode: 'launch', userDataDir: 'state/chrome' } } as const;

const setup: PluginSetup = async (ctx): Promise<PluginSetupResult> => {
  const existing = ctx.config.browser;
  if (existing !== undefined && existing !== false)
    throw new Error(
      'The browser is already configured (the browser block in config.json). Edit that block; install configures a capability that is not configured yet.',
    );
  ctx.note(
    'Which Chrome aivi drives',
    [
      'launch (what this writes): aivi starts its own Chrome under <home>/state/chrome on the first browser call.',
      '  Nothing else needs to be running; logins made in that window persist there.',
      'existing: a Chrome you started yourself with --user-data-dir, extensions and logins prepared by hand.',
      'attach: your own running Chrome over remote debugging (chrome://inspect/#remote-debugging, or',
      '  --remote-debugging-port=9222). aivi’s tabs open in your Chrome; unattended work then depends on it being open.',
      'Details and the exact block shapes: docs/browser.md. existing and attach are written by hand into',
      'config.json after installing — rerun this command only after removing the block.',
    ].join('\n'),
  );
  const wantsOwnChrome = await ctx.ask.confirm({
    message: 'Let aivi launch and drive its own Chrome? (recommended)',
    initial: true,
  });
  if (!wantsOwnChrome)
    throw new Error(
      'Nothing was written. For the existing or attach modes, add the browser block to config.json yourself — docs/browser.md has the shapes — then restart aivi.',
    );
  const block = LAUNCH_BLOCK;
  const parsed = browserConfigSchema.safeParse(block);
  if (!parsed.success) throw new Error('The launch block aivi writes does not load its own schema; this is a bug.');
  await ctx.writeConfigBlock(['browser'], block);
  return {
    module: 'browser',
    summary: 'Browser is configured: aivi launches its own Chrome under state/chrome on the first browser call.',
  };
};

export default setup;
