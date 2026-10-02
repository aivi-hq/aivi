/** The forge's part in `aivi projects add`: what repository this project is,
 *  and its checkout. The runner walks core's roles and calls this for the
 *  `forge` role; everything GitHub-specific lives in this file, and the
 *  questions are asked with the runner's own clack.
 *
 *  The clone is the reason the role is the forge's and not aivi's: cloning
 *  reaches `origin`, and reaching `origin` authenticates. So aivi clones as
 *  **its own app** through the one installation token, in the command's own
 *  environment — the person's keychain is never offered, and no token is left
 *  in the checkout for someone to find later.
 */
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getLogger, PROJECT_ID } from '@aivi/core';
import { PluginSetupCancelled, type ProjectContributor, type ProjectSetupContext } from '@aivi/plugin';
import { forgeGithubSchema } from './config.ts';
import { GitHubApp, gitCredential, runGit } from './github.ts';
import { httpsRemote, isGitHub, parseRemote } from './remote.ts';

/** The project name a repository suggests: GitHub's `My-Repo` becomes aivi's
 *  `my-repo`, the shape a project directory takes. Anything the id rule does
 *  not allow becomes a dash, and a name that no longer starts with a letter
 *  keeps one. */
export function suggestedProjectId(repoName: string): string {
  const folded = repoName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return /^[a-z]/.test(folded) ? folded : `p-${folded}`;
}

/** A prompt the person cancelled is not an answer: nothing further is written
 *  and the runner says the one cancel line. */
async function settled<T>(ctx: ProjectSetupContext, answer: Promise<T | symbol>): Promise<T> {
  const value = await answer;
  if (ctx.prompts.isCancel(value)) throw new PluginSetupCancelled('a prompt was cancelled');
  return value as T;
}

/** The repository asked for and read for what it is. Undefined when the answer
 *  names no GitHub repository at all: a non-GitHub host is said plainly, since
 *  a person typing a GitLab URL means it, and silence would lose the project. */
async function askRepository(ctx: ProjectSetupContext) {
  const answer = await settled(
    ctx,
    ctx.prompts.text({
      message: 'Which GitHub repository is this project?',
      placeholder: 'owner/repo, or its URL',
      validate: value => (parseRemote(value ?? '') ? undefined : 'Give it as owner/repo, or as a github.com URL'),
    }),
  );
  const remote = parseRemote(String(answer).trim());
  if (!remote) return undefined;
  if (!isGitHub(remote))
    throw new Error(
      `${remote.host} is not github.com, and this forge speaks github.com repositories only. Clone that project by hand, or point aivi at a different forge.`,
    );
  return remote;
}

export const contributor: ProjectContributor = {
  role: 'forge',
  async setup(ctx: ProjectSetupContext) {
    const log = getLogger(['aivi', 'forge-github']);
    const config = forgeGithubSchema.parse(ctx.config);
    const app = await GitHubApp.connect(config, { log });
    const remote = await askRepository(ctx);
    if (!remote) throw new Error('no repository named');
    const id = `${remote.owner}/${remote.repo}`;

    // Proven under the grant before a directory is made: GitHub answers 404 for
    // a repository the app was not given, so this is also the answer to "is
    // this repository in the installation's set".
    const seen = await app.repository(remote.owner, remote.repo);
    if (!seen)
      throw new Error(
        `the app ${app.appSlug} cannot see ${id} through installation #${app.installationId}. Grant it that repository on GitHub and run this again.`,
      );
    await ctx.prompts.log.message(`The app reads ${id} (default branch ${seen.defaultBranch}).`);

    const suggestion = suggestedProjectId(remote.repo);
    const projectId = ctx.projectId
      ? String(ctx.projectId)
      : String(
          await settled(
            ctx,
            ctx.prompts.text({
              message: 'Project name',
              placeholder: suggestion,
              defaultValue: suggestion,
              validate: value =>
                value !== undefined && PROJECT_ID.test(value)
                  ? undefined
                  : 'lowercase letters, digits, dashes and underscores, starting with a letter',
            }),
          ),
        );
    const source = join(ctx.home, 'projects', projectId, 'source');

    // A checkout already there belongs to its owner. The same repository means
    // aivi found what it was looking for and takes it as it stands; a different
    // one means aivi would be writing a stranger's remote into a person's
    // working copy, which is a decision and never a default.
    if (await stat(join(source, '.git')).catch(() => null)) {
      const origin = await runGit(source, ['remote', 'get-url', 'origin']);
      const found = origin.ok ? parseRemote(origin.stdout) : undefined;
      if (found && `${found.owner}/${found.repo}` === id) {
        await ctx.prompts.log.message(`projects/${projectId}/source is already a checkout of ${id}; left as it is.`);
        return { id: projectId, cloned: true };
      }
      throw new Error(
        `projects/${projectId}/source is a checkout of ${found ? `${found.owner}/${found.repo}` : 'something that is not a GitHub repository'}. Move it aside, or choose a project name that has no checkout yet.`,
      );
    }

    const credential = gitCredential(await app.gitToken());
    await mkdir(dirname(source), { recursive: true });
    const spinner = ctx.prompts.spinner();
    spinner.start(`cloning ${id}…`);
    const cloned = await runGit(dirname(source), ['clone', '--quiet', httpsRemote(remote), source], {
      env: credential,
    });
    // A clone that failed leaves a project with no checkout, and the runner
    // would then write its "no source" note over the half-made directory: the
    // flow stops here rather than reporting a project that is not one.
    if (!cloned.ok) {
      spinner.stop(`could not clone ${id}: ${cloned.message}`);
      throw new Error(`clone of ${id} failed: ${cloned.message}`);
    }
    spinner.stop(`Cloned ${id} into projects/${projectId}/source.`);
    return { id: projectId, cloned: true };
  },
};
