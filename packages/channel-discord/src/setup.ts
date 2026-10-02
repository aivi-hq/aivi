/**
 * The setup `aivi add discord` runs: everything Discord-specific lives in
 * this file — how to create the application, which secret to ask for and how
 * to verify it, what to write into config.json and .env. The CLI runs it
 * blind: it installs the package, hands it a context, and brings aivi back
 * when this resolves. The flow draws all its own lines with the clack on
 * the context and settles each animation before it returns or throws.
 * Nothing is written before it is true: the token answers Discord first,
 * every id matches the platform's shape, and a config.json that no longer
 * loads is restored to its old bytes.
 */
import { type PluginSetup, PluginSetupCancelled, type PluginSetupContext, type PluginSetupResult } from '@aivi/plugin';
import { MODULE_ID } from './config.ts';

/** Clack answers Ctrl+C with its cancel symbol and an empty Enter with
 *  nothing — neither is an answer. The flow stops with
 *  `PluginSetupCancelled` and the runner says the one cancel line; prompts
 *  that must not be empty say so in their `validate`, so clack re-asks
 *  before this ever sees the gap. */
function settled<T>(ctx: PluginSetupContext, answer: T): Exclude<NonNullable<T>, symbol> {
  if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('a prompt was cancelled');
  if (answer === undefined) throw new PluginSetupCancelled('a prompt was submitted empty');
  return answer as Exclude<NonNullable<T>, symbol>;
}

/** Discord ids are snowflakes: 17–20 digits (the config schema checks them too). */
const SNOWFLAKE = /^\d{17,20}$/;

/** The bot user a token belongs to: `GET /users/@me` with Bot auth. Its id is the application id. */
interface DiscordBotUser {
  id: string;
  username: string;
}

async function fetchBotUser(ctx: PluginSetupContext, token: string): Promise<DiscordBotUser> {
  const response = await ctx.fetch('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bot ${token}` },
  });
  if (response.status === 401) throw new Error('Discord refused that token (401). Copy it again from the Bot page.');
  if (!response.ok) throw new Error(`Discord answered ${response.status} — is the token pasted whole?`);
  return (await response.json()) as DiscordBotUser;
}

/** Ids pasted one per answer until an empty one stops the loop. */
async function collectIds(ctx: PluginSetupContext, first: string, again: string): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const answer = settled(
      ctx,
      await ctx.prompts.text({
        message: ids.length ? again : first,
        validate: value => {
          const id = (value ?? '').trim();
          return !id || SNOWFLAKE.test(id) ? undefined : 'A Discord id is 17–20 digits — or an empty line to stop';
        },
      }),
    ).trim();
    if (!answer) return ids;
    ids.push(answer);
  }
}

const setup: PluginSetup = async (ctx): Promise<PluginSetupResult> => {
  const existing = (ctx.config.plugins as Record<string, unknown> | undefined)?.[MODULE_ID];
  if (existing !== undefined)
    throw new Error(
      'Discord is already configured (the plugins.channel-discord block in config.json). Edit that block; aivi add configures a module that is not configured yet.',
    );
  ctx.prompts.note(
    [
      `1. discord.com/developers/applications → New Application → name it ${ctx.identityName}.`,
      '2. On the Bot page: Reset Token → copy the token; you paste it here when asked.',
      '3. Still on the Bot page: leave the Message Content intent off unless you want aivi to read plain messages — asked below.',
      '4. On OAuth2 → URL Generator: scopes bot + applications.commands; Bot Permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions. Copy the URL, open it, Invite the bot to your server.',
    ].join('\n'),
    'Create the Discord application',
  );
  const token = settled(
    ctx,
    await ctx.prompts.password({
      message: 'Bot token — the one the Bot page gave you',
      validate: value => (value?.trim() ? undefined : 'Paste the token from Discord'),
    }),
  ).trim();
  await ctx.prompts.log.message('Asking Discord who this token belongs to…');
  const bot = await fetchBotUser(ctx, token);
  await ctx.prompts.log.message(`Verified: @${bot.username} — application ${bot.id}.`);

  // DMs are open to whoever links (the code is the door); the install only picks the places.
  const wantsChannels = settled(
    ctx,
    await ctx.prompts.confirm({ message: 'Listen in shared channels?', initialValue: true }),
  );
  const channelIds = wantsChannels
    ? await collectIds(
        ctx,
        'A channel id — right-click the channel → Copy Channel ID',
        'Another channel id (empty line stops)',
      )
    : [];

  const intent = settled(
    ctx,
    await ctx.prompts.confirm({
      message: 'Did you enable the Message Content intent on the Bot page?',
      initialValue: false,
    }),
  );
  if (!intent && channelIds.length)
    await ctx.prompts.log.message(
      'Without that intent aivi answers only @-mentions and DMs: each channel gets trigger "mention".',
    );
  const wantsReports = settled(
    ctx,
    await ctx.prompts.confirm({ message: 'Post scheduled job outcomes to some channels?', initialValue: false }),
  );
  const reportChannels = wantsReports
    ? await collectIds(ctx, 'A report channel id', 'Another report channel id (empty line stops)')
    : [];

  const block = {
    applicationId: bot.id,
    access: {
      channels: channelIds.map(id => ({ id, ...(intent ? {} : { trigger: 'mention' }) })),
    },
    ...(reportChannels.length ? { reportChannels } : {}),
    ...(intent ? { messageContent: true } : {}),
  };
  await ctx.writeSecret('DISCORD_BOT_TOKEN', token);
  await ctx.writeConfigBlock(['plugins', MODULE_ID], block);
  return {
    module: MODULE_ID,
    summary: [
      `Discord is configured for @${bot.username} (application ${bot.id}).`,
      channelIds.length ? '' : 'No shared channels: aivi will answer DMs only.',
      'To talk to it: start aivi, run `aivi link discord`, and paste the code to the bot with /link.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
};

export default setup;
