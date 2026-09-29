/** Linear's project-setup contributor, at its `./setupProject` subpath: it
 *  maps a new project to Linear teams and lanes. It clones nothing (a tracker
 *  has no checkout to give) and hands back the `linear` section core writes
 *  under the project. Everything Linear-specific — apps, teams, workflow
 *  states — lives here; core only knows this plugin serves the `tracker` role. */
import { getLogger } from '@aivi/core';
import { PluginSetupCancelled, type ProjectContributor, type ProjectSetupContext } from '@aivi/plugin';
import { type LinearTeam, resolveTeams } from './client.ts';
import type { LaneValue, LinearConfig } from './config.ts';
import { clientFor } from './tracker.ts';

const log = getLogger(['aivi', 'projects']);

const contributor: ProjectContributor = {
  role: 'tracker',
  async setup(ctx) {
    const config = ctx.config as LinearConfig;
    const appIds = Object.keys(config.apps ?? {});
    let app: string | undefined;
    if (appIds.length > 1) {
      const picked = await ctx.prompts.select({
        message: 'Ask which Linear app for teams',
        options: appIds.map(name => ({ value: name, label: name })),
      });
      if (ctx.prompts.isCancel(picked)) throw new PluginSetupCancelled('no app chosen');
      app = picked as string;
    }

    const spinner = ctx.prompts.spinner();
    spinner.start('Asking the app which teams it can see');
    let teams: LinearTeam[];
    try {
      teams = await clientFor(config, app, log).listTeams();
      spinner.stop(`The app can see ${teams.length} team${teams.length === 1 ? '' : 's'}`);
    } catch (error) {
      spinner.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (!teams.length) throw new Error('that Linear app sees no teams — a private team needs the app added to it');

    const pickedTeams = await ctx.prompts.multiselect({
      message: 'Which teams may work in this project?',
      options: teams.map(team => ({ value: team.id, label: `${team.key} — ${team.name}`, hint: team.id })),
      required: true,
    });
    if (ctx.prompts.isCancel(pickedTeams)) throw new PluginSetupCancelled('no teams picked');
    const teamIds = pickedTeams as string[];
    const chosen = teams.filter(team => teamIds.includes(team.id));

    // The name: a tracker offers the first team's key, lower-cased, unless an
    // earlier role (a forge) already settled it.
    const suggested = (ctx.projectId ?? chosen[0]!.key).toLowerCase();
    const idAnswer = await ctx.prompts.text({
      message: "Project id — aivi's name for it; Linear never sees it.",
      placeholder: suggested,
    });
    if (ctx.prompts.isCancel(idAnswer)) throw new PluginSetupCancelled('no project id given');
    const id = (String(idAnswer).trim() || suggested).toLowerCase();

    // Lanes: the projectDefaults convention is the base; only the states it
    // leaves open get asked, and a state that only ends work never does.
    const conventions = (ctx.projectDefaults?.lanes ?? {}) as Record<string, LaneValue>;
    const open = [
      ...new Set(
        chosen.flatMap(team =>
          team.states.filter(state => state.type !== 'completed' && state.type !== 'canceled').map(state => state.name),
        ),
      ),
    ].filter(name => !(name in conventions));
    const lanes: Record<string, string | null> = {};
    for (const name of open) {
      const answer = await ctx.prompts.text({
        message: `Which OpenCode agent works the "${name}" lane?`,
        placeholder: 'leave empty to leave it for humans',
      });
      if (ctx.prompts.isCancel(answer)) throw new PluginSetupCancelled('lane setup incomplete');
      lanes[name] = String(answer).trim() ? String(answer).trim() : null;
    }
    if (!open.length)
      await ctx.prompts.log.message('the projectDefaults convention already covers every lane these teams work in');

    const section: Record<string, unknown> = { teams: resolveTeams(teams, teamIds) };
    if (Object.keys(lanes).length) section.lanes = { ...conventions, ...lanes };
    return { id, section, cloned: false };
  },
};

export default contributor;
export { contributor };
