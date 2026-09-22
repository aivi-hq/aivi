/**
 * The setup `aivi install slack` runs: everything Slack-specific lives in
 * this file — the app manifest to paste, which two tokens to ask for and how
 * to verify them, what to write into config.json and .env. The CLI runs it
 * blind: it installs the package, hands it a context, and brings aivi back
 * when this resolves. Nothing is written before it is true: each token
 * answers Slack first, every id matches the platform's shape, and a
 * config.json that no longer loads is restored to its old bytes.
 */
import type { PluginSetup, PluginSetupContext, PluginSetupResult } from '@aivi/core';
import { isChannelId, isUserId } from './config.ts';
import { slackManifest } from './module.ts';

/** One Slack POST with bearer auth; the API answers 200 plus {ok:false} for a refusal. */
async function slackApi(
  ctx: PluginSetupContext,
  method: 'auth.test' | 'apps.connections.open',
  token: string,
): Promise<Record<string, unknown>> {
  const response = await ctx.fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}.`);
  const body = (await response.json()) as { ok?: boolean; error?: string } & Record<string, unknown>;
  if (!body.ok) {
    const what = method === 'apps.connections.open' ? 'Socket Mode' : method;
    throw new Error(`Slack refused that token (${what}: ${body.error ?? 'not ok'}).`);
  }
  return body;
}

/** Ids pasted one per answer until an empty one stops the loop. */
async function collectIds(
  ctx: PluginSetupContext,
  first: string,
  again: string,
  shape: (id: string) => boolean,
  label: string,
): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const answer = (
      await ctx.ask.text({
        message: ids.length ? again : first,
        validate: value => (!value.trim() || shape(value.trim()) ? undefined : `${label} — or an empty line to stop`),
      })
    ).trim();
    if (!answer) return ids;
    ids.push(answer);
  }
}

const setup: PluginSetup = async (ctx): Promise<PluginSetupResult> => {
  const existing = (ctx.config.modules as Record<string, unknown> | undefined)?.slack;
  if (existing !== undefined && existing !== false)
    throw new Error(
      'Slack is already configured (the modules.slack block in config.json). Edit that block; install configures a module that is not configured yet.',
    );
  const prefix = (
    await ctx.ask.text({
      message: 'Slash command prefix — the commands become /<prefix>-new, /<prefix>-status, …',
      placeholder: 'aivi',
      validate: value => (/^[a-z][a-z0-9_-]*$/.test(value.trim()) ? undefined : 'Lowercase letters, digits, _ or -'),
    })
  ).trim();
  ctx.note(
    'Create the Slack app',
    [
      '1. api.slack.com/apps?new_app=1 → From an app manifest → pick the workspace → paste the manifest below → Create.',
      '2. Install the app to the workspace → copy the Bot User OAuth Token (xoxb-…); you paste it here when asked.',
      '3. Basic Information → App-Level Tokens → Generate Token and Scopes: name it socket, scope connections:write → copy the xapp-… token.',
      `4. In Slack, invite @${ctx.identityName} to every channel it should listen in.`,
      '',
      'App manifest — paste this:',
      JSON.stringify(slackManifest(prefix, { name: ctx.identityName }), null, 2),
    ].join('\n'),
  );

  const botToken = (
    await ctx.ask.text({
      message: 'Bot token — the xoxb-… from the install page',
      secret: true,
      validate: value => (value.trim().startsWith('xoxb-') ? undefined : 'A bot token starts with xoxb-'),
    })
  ).trim();
  ctx.log('Asking Slack who this token belongs to…');
  const auth = await slackApi(ctx, 'auth.test', botToken);
  const workspace = String(auth.team ?? auth.team_id ?? 'your workspace');
  ctx.log(`Verified: bot @${String(auth.user ?? auth.user_id)} in ${workspace}.`);

  const appToken = (
    await ctx.ask.text({
      message: 'App-level token — the xapp-… with connections:write',
      secret: true,
      validate: value => (value.trim().startsWith('xapp-') ? undefined : 'An app-level token starts with xapp-'),
    })
  ).trim();
  await slackApi(ctx, 'apps.connections.open', appToken);
  ctx.log('Verified: the app-level token opens Socket Mode.');
  const wantsDm = await ctx.ask.confirm({ message: 'Let yourself DM the bot?', initial: true });
  const dmUsers = wantsDm
    ? [
        (
          await ctx.ask.text({
            message: 'Your Slack member id — your profile → ⋯ → Copy member ID (starts with U)',
            validate: value => (isUserId(value.trim()) ? undefined : 'A Slack user id starts with U'),
          })
        ).trim(),
      ]
    : [];
  const wantsChannels = await ctx.ask.confirm({ message: 'Listen in shared channels too?', initial: !wantsDm });
  const channelIds = wantsChannels
    ? await collectIds(
        ctx,
        'A channel id — channel details → Copy channel ID (starts with C or G)',
        'Another channel id (empty line stops)',
        isChannelId,
        'A Slack channel id starts with C or G',
      )
    : [];
  if (!dmUsers.length && !channelIds.length)
    throw new Error('Nothing would hear anyone: answer yes to DMs or add at least one channel.');
  const wantsReports = await ctx.ask.confirm({
    message: 'Post scheduled job outcomes to some channels?',
    initial: false,
  });
  const reportChannels = wantsReports
    ? await collectIds(
        ctx,
        'A report channel id',
        'Another report channel id (empty line stops)',
        isChannelId,
        'A Slack channel id starts with C or G',
      )
    : [];

  const block = {
    commandPrefix: prefix,
    access: {
      ...(dmUsers.length ? { dm: { users: dmUsers } } : {}),
      channels: channelIds.map(id => ({ id })),
    },
    ...(reportChannels.length ? { reportChannels } : {}),
  };
  await ctx.writeSecret('SLACK_BOT_TOKEN', botToken);
  await ctx.writeSecret('SLACK_APP_TOKEN', appToken);
  await ctx.writeConfigBlock(['modules', 'slack'], block);
  return {
    module: 'slack',
    summary: `Slack is configured for workspace ${workspace}: /${prefix}-* commands.`,
  };
};

export default setup;
