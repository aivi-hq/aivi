/** The `forge-github` module: the app, proven at boot and standing by.
 *
 *  **Nothing asks a forge a question yet, and this module does not pretend
 *  otherwise.** The `Forge` contract is built and answered (`./forge.ts`), and
 *  the two flows that consume it today are the CLI's own: `aivi add` runs the
 *  setup guide, `aivi projects add` runs the clone contributor. What is missing
 *  is the machinery that would ask on a worker's behalf — the host-side forge
 *  registry, the first thing with the question "who owns this project's
 *  remote?" to ask — and it arrives with the orchestrator
 *  ([the plan](../../../docs/plans/forge-github.md)).
 *
 *  So the module's work is to **prove the credential at boot and hold the
 *  answer**: an app whose key was rotated, an installation that was revoked or
 *  was never made, a grant that turned into two — each is said once, loudly,
 *  where `/status` shows it, rather than at the first push a worker is waiting
 *  on. One transfer aivi runs today belongs here by right — the sync of a
 *  project's `source/`, which reaches `origin` — and the host still performs
 *  it as plain git naming no plugin, because choosing between forges is the
 *  registry's job and that lands with the orchestrator.
 */
import type { AiviModule, AiviServices } from '@aivi/plugin';
import type { ForgeGithubConfig } from './config.ts';
import { GitHubApp } from './github.ts';

async function startForge(config: ForgeGithubConfig, services: AiviServices): Promise<{ stop: () => Promise<void> }> {
  const log = services.log.getChild('forge-github');
  // Every failure here is a ConfigurationError naming what to fix on GitHub or
  // in .env: the module goes to error, `/status` says so, and nothing retries.
  const app = await GitHubApp.connect(config, { log });
  log.info('ready', {
    installation: app.installationId,
    account: app.accountLogin,
    note: 'the forge answers the CLI flows; the orchestrator asks the first questions',
  });
  return {
    // No routes, no tasks, no timers: there is nothing to release.
    stop: async () => {},
  };
}

export function createForgeGithubModule(config: ForgeGithubConfig): AiviModule {
  return { id: 'forge-github', start: services => startForge(config, services) };
}
