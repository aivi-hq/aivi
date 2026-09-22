/**
 * The setup `aivi install discord` runs: everything Discord-specific lives in
 * this file — how to create the application, which secret to ask for and how
 * to verify it, what to write into config.json and .env. The CLI runs it
 * blind: it installs the package, hands it a context, and brings aivi back
 * when this resolves. Nothing is written before it is true: the token answers
 * Discord first, every id matches the platform's shape, and a config.json
 * that no longer loads is restored to its old bytes.
 */
import type { PluginSetup, PluginSetupContext, PluginSetupResult } from '@aivi/core';

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

/** One snowflake, asked until it matches. */
async function askSnowflake(ctx: PluginSetupContext, message: string): Promise<string> {
  for (;;) {
    const answer = (
      await ctx.ask.text({
        message,
        validate: value => (SNOWFLAKE.test(value.trim()) ? undefined : 'A Discord id is 17–20 digits'),
      })
    ).trim();
    if (answer) return answer;
  }
}

/** Ids pasted one per answer until an empty one stops the loop. */
async function collectIds(ctx: PluginSetupContext, first: string, again: string): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const answer = (
      await ctx.ask.text({
        message: ids.length ? again : first,
        validate: value =>
          !value.trim() || SNOWFLAKE.test(value.trim())
            ? undefined
            : 'A Discord id is 17–20 digits — or an empty line to stop',
      })
    ).trim();
    if (!answer) return ids;
    ids.push(answer);
  }
}

const setup: PluginSetup = async (ctx): Promise<PluginSetupResult> => {
  const existing = (ctx.config.modules as Record<string, unknown> | undefined)?.discord;
  if (existing !== undefined && existing !== false)
    throw new Error(
      'Discord is already configured (the modules.discord block in config.json). Edit that block; install configures a module that is not configured yet.',
    );
  ctx.note(
    'Create the Discord application',
    [
      `1. discord.com/developers/applications → New Application → name it ${ctx.identityName}.`,
      '2. On the Bot page: Reset Token → copy the token; you paste it here when asked.',
      '3. Still on the Bot page: leave the Message Content intent off unless you want aivi to read plain messages — asked below.',
      '4. On OAuth2 → URL Generator: scopes bot + applications.commands; Bot Permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions. Copy the URL, open it, Invite the bot to your server.',
    ].join('\n'),
  );
  const token = (
    await ctx.ask.text({
      message: 'Bot token — the one the Bot page gave you',
      secret: true,
      validate: value => (value.trim() ? undefined : 'Paste the token from Discord'),
    })
  ).trim();
  ctx.log('Asking Discord who this token belongs to…');
  const bot = await fetchBotUser(ctx, token);
  ctx.log(`Verified: @${bot.username} — application ${bot.id}.`);

  const wantsDm = await ctx.ask.confirm({ message: 'Let yourself DM the bot?', initial: true });
  const dmUsers = wantsDm
    ? [await askSnowflake(ctx, 'Your Discord user id — Developer Mode on, right-click your name → Copy User ID')]
    : [];
  const wantsChannels = await ctx.ask.confirm({ message: 'Listen in shared channels too?', initial: !wantsDm });
  const channelIds = wantsChannels
    ? await collectIds(
        ctx,
        'A channel id — right-click the channel → Copy Channel ID',
        'Another channel id (empty line stops)',
      )
    : [];
  if (!dmUsers.length && !channelIds.length)
    throw new Error('Nothing would hear anyone: answer yes to DMs or add at least one channel.');

  const intent = await ctx.ask.confirm({
    message: 'Did you enable the Message Content intent on the Bot page?',
    initial: false,
  });
  if (!intent && channelIds.length)
    ctx.log('Without that intent aivi answers only @-mentions and DMs: each channel gets trigger "mention".');
  const wantsReports = await ctx.ask.confirm({
    message: 'Post scheduled job outcomes to some channels?',
    initial: false,
  });
  const reportChannels = wantsReports
    ? await collectIds(ctx, 'A report channel id', 'Another report channel id (empty line stops)')
    : [];

  const block = {
    applicationId: bot.id,
    access: {
      ...(dmUsers.length ? { dm: { users: dmUsers } } : {}),
      channels: channelIds.map(id => ({ id, ...(intent ? {} : { trigger: 'mention' }) })),
    },
    ...(reportChannels.length ? { reportChannels } : {}),
    ...(intent ? { messageContent: true } : {}),
  };
  await ctx.writeSecret('DISCORD_BOT_TOKEN', token);
  await ctx.writeConfigBlock(['modules', 'discord'], block);
  return {
    module: 'discord',
    summary: `Discord is configured for @${bot.username} (application ${bot.id}).`,
  };
};

export default setup;
