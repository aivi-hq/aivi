/**
 * The setup `aivi add @aivi/google-meet` runs: there is no account and no
 * secret — Meet takes the browser you already have and the voice you already
 * configured. The defaults would run an unconfigured block fine, so the
 * flow's real work is telling the operator the two dependencies a meeting
 * stands on (a configured voice plugin, a running serve) and writing down
 * the one question an operator actually flips — watch the window or not.
 */

import { type PluginSetup, type PluginSetupResult, settled } from '@aivi/plugin';
import { MODULE_ID, meetConfigSchema } from './config.ts';

const setup: PluginSetup = async (ctx): Promise<PluginSetupResult> => {
  const existing = (ctx.config.plugins as Record<string, unknown> | undefined)?.[MODULE_ID];
  if (existing !== undefined)
    throw new Error(
      'Google Meet is already configured (the plugins.google-meet block in config.json). Edit that block; aivi add configures a plugin that is not configured yet.',
    );
  ctx.prompts.note(
    [
      'Meet opens a Google Meet call in your own Chrome: the aivi face as the camera, the waiting room',
      'clicked through, everyone heard and answered. It needs two things it does not own:',
      '  • @aivi/voice configured (aivi add @aivi/voice) — it is the brain: hearing, speakers, speaking.',
      '  • aivi serve RUNNING — the meeting lives in the server, not in this terminal.',
      'Chrome keeps its Google sign-in in its own profile: join a real meeting once in that Chrome if',
      'the calendar-invited path is what you want; guest links work unsigned-in.',
    ].join('\n'),
    'What Meet needs',
  );
  const headed = settled(
    ctx,
    await ctx.prompts.confirm({
      message:
        'Open a visible Chrome window for meetings? (Default: headless — the face tab still renders, nothing shows on screen)',
      initialValue: false,
    }),
  );
  const block: Record<string, unknown> = {
    mode: 'call',
    ...(headed ? { headless: false } : {}),
  };
  const parsed = meetConfigSchema.safeParse(block);
  if (!parsed.success) throw new Error('The Meet block aivi writes does not load its own schema; this is a bug.');
  await ctx.writeConfigBlock(['plugins', MODULE_ID], block);
  const voiceReady = (plugins: unknown) => typeof plugins === 'object' && plugins !== null && 'voice' in plugins;
  return {
    module: MODULE_ID,
    summary: `Meet is configured — ${headed ? 'meetings open a visible window' : 'headless'}${
      voiceReady(ctx.config.plugins)
        ? ', voice is configured'
        : ', but voice is NOT configured yet: aivi add @aivi/voice first'
    }. With serve running: aivi meet join https://meet.google.com/xxx-xxxx-xxx`,
  };
};

export default setup;
