/** The `forge-github` module: the app, proven at boot, registered, standing by.
 *
 *  The module's work is to **prove the credential at boot and register the
 *  answer**: an app whose key was rotated, an installation that was revoked
 *  or was never made, a grant that turned into two — each is said once,
 *  loudly, where `/status` shows it, rather than at the first push a worker
 *  is waiting on. The registry question — *"who owns this project's
 *  remote?"* — is asked now (built 2026-10-02): the projects-sync task was
 *  the first, and a checkout whose `origin` this app recognises syncs
 *  through this forge, authenticated as its own installation. The push asks
 *  it today — the worker's `aivi_pr` call ends here — and the review gather
 *  will ask it when it comes.
 */
import type { AiviModule, AiviServices } from '@aivi/plugin';
import type { ForgeGithubConfig } from './config.ts';
import { createGitHubForge } from './forge.ts';
import { GitHubApp } from './github.ts';

async function startForge(config: ForgeGithubConfig, services: AiviServices): Promise<{ stop: () => Promise<void> }> {
  const log = services.log.getChild('forge-github');
  // Every failure here is a ConfigurationError naming what to fix on GitHub or
  // in .env: the module goes to error, `/status` says so, and nothing retries.
  const app = await GitHubApp.connect(config, { log });
  const unregister = services.forges.register(createGitHubForge(app, { log }));
  log.info('ready', {
    installation: app.installationId,
    account: app.accountLogin,
    note: 'registered on the forge registry; the host asks who owns each remote',
  });
  return {
    // No routes, no tasks, no timers: only the registration to give back.
    stop: async () => {
      unregister();
    },
  };
}

export function createForgeGithubModule(config: ForgeGithubConfig): AiviModule {
  return { id: 'forge-github', start: services => startForge(config, services) };
}
