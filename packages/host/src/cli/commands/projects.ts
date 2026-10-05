/** Projects: the directories of <home>/projects and their sources. `add`
 *  walks core's roles (forge, tracker) and lets the configured plugin of each
 *  set the project up; core names no plugin. list/remove/purge read only
 *  core's view of the project directory. */

import { projectSummaries, purgeProject, removeProject } from '@aivi/core';
import type { Command } from 'commander';
import { configPath, context, home, print } from '../context.ts';
import { runProjectSetup } from '../project-setup.ts';

export function registerProjects(program: Command): void {
  const projects = program
    .command('projects')
    .description('projects: the directories of <home>/projects')
    .helpGroup('Projects');
  projects
    .command('list')
    .description('Projects with their sources; removed ones keep their memory')
    .action(async () => {
      const { loaded } = await context();
      print(
        projectSummaries(loaded).map((project, i) => ({
          ...project,
          ...(project.removed ? {} : { directory: loaded.projects[i]!.directory }),
        })),
      );
    });
  projects
    .command('add [name]')
    .description('set a project up: the configured forge clones it, the configured tracker maps it')
    .action(async (name?: string) => {
      await runProjectSetup({ home: home(), configPath: configPath(), ...(name ? { name } : {}) });
    });
  projects
    .command('remove <id>')
    .description('Delete the checkout; memory stays and the project is listed as removed')
    .action(async id => {
      print(await removeProject(configPath(), id));
      console.error('Memory kept; the project is listed as removed until `aivi projects purge`. Restart `aivi serve`.');
    });
  projects
    .command('purge <id>')
    .description("Delete the project's memory (and checkout); without --confirm only shows what would go")
    .option('--confirm', 'really delete; memory cannot be recovered')
    .action(async (id, values) => {
      const purge = await purgeProject(configPath(), id, { confirm: values.confirm ?? false });
      print(purge);
      if (!purge.purged) {
        console.error('Nothing deleted. Re-run with --confirm to delete these paths; memory cannot be recovered.');
        process.exitCode = 1;
      } else console.error('Restart `aivi serve` so the index forgets it.');
    });
}
