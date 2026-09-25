import type { LoadedConfig, ModuleHealth, Status } from '@aivi/core';
import { taskLabel } from '@aivi/core';
import type { Store } from '../store.ts';
import { hostVersion } from '../version.ts';

/**
 * The host's own report, as `GET /status` and the `aivi_status` tool answer
 * it. The version is the package-set constant every client negotiates with.
 */
export function status(store: Store, loaded: LoadedConfig, now = Date.now(), modules: ModuleHealth[] = []): Status {
  return {
    version: hostVersion,
    counts: store.counts(),
    sources: loaded.sources.length,
    leases: store.leaseCount(),
    completion: 'verified-final-answer',
    modules,
    upcoming: store
      .jobs()
      .filter(j => j.state === 'active' && j.nextAt !== null)
      .slice(0, 3)
      .map(j => ({
        id: j.spec.id,
        source: j.source,
        kind: taskLabel(j.spec.task),
        title: j.spec.title ?? null,
        nextAt: new Date(j.nextAt!).toISOString(),
      })),
    recent: store.recent(now - 24 * 3_600_000, 20).map(r => ({
      id: r.id,
      jobId: r.jobId,
      kind: taskLabel(r.task),
      state: r.state,
      finishedAt: new Date(r.finishedAt ?? now).toISOString(),
      error: r.error,
    })),
  };
}
