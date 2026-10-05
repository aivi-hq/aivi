/**
 * The forge registry: the first thing with the question **"who owns this
 * project's remote?"** to ask (built 2026-10-02; the contract is the kit's
 * `Forges`). Forge modules register once at module start; the host's
 * machinery asks — today the projects-sync task, tomorrow the push and the
 * review wake.
 *
 * The answer may be nobody (ruled 2026-09-29: the forge is a configurable
 * path, not the spine), and asking is cheap by contract: recognising reads
 * `origin` with a local git read, and nothing here reaches a network. What
 * the caller does with an owner is the caller's business; the registry only
 * keeps the list honest.
 */
import type { Forge, ForgeOwner, ForgeProject, Forges as ForgesApi } from '@aivi/plugin/forge';

export class Forges implements ForgesApi {
  private readonly registered = new Set<Forge>();

  register(forge: Forge): () => void {
    this.registered.add(forge);
    return () => {
      this.registered.delete(forge);
    };
  }

  /** The first registered forge that recognises the project's remote owns
   *  it. A forge that cannot read `origin` says *not mine* (the kit's
   *  `repoFor` contract), so an unreadable directory simply has no forge. */
  async owner(project: ForgeProject): Promise<ForgeOwner | undefined> {
    for (const forge of this.registered) {
      const repo = await forge.repoFor(project);
      if (repo) return { forge, repo };
    }
    return undefined;
  }
}
