/**
 * The work a tracker answers for: the **stages** the orchestrator walks a
 * run through, and the board it walks for work. Division of labour, said
 * as an interface: the orchestrator orchestrates and never learns what a
 * ticket platform is; the tracker tracks and answers for its platform
 * alone. A tracker module registers ONE of these at start; the
 * orchestrator calls the stages in the documented order and awaits only
 * the lifecycle ones (`initWork`, `endWork`): their failure is the run's
 * failure, said visibly. The renders (`ready`, `startWork`, `question`,
 * `plan`) are fire-and-forget — a platform that cannot show a thing loses
 * nothing the orchestrator cares about, and a tracker retries its own
 * renders in its own time.
 *
 * The interface is the orchestrator's contract to keep — its source lives
 * beside the machinery that calls it (`@aivi/host`); the kit re-exports it
 * because this is where module authors meet it, and the order it says is
 * owned by `docs/orchestrator.md` ("The tracker's stages").
 */
export type { Tracker } from '@aivi/host';
