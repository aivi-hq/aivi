/**
 * The orchestrator's **run events**, re-exported where a tracker author
 * imports them. The orchestrator orchestrates: it never calls a tracker and
 * never learns which platform is listening. It emits these facts as its runs
 * change — started, question, plan, ended — and a tracker that wants to
 * follow subscribes and renders them in its own platform, in its own time,
 * retrying its own failures. A tracker that listens to nothing loses nothing
 * the orchestrator cares about.
 *
 * The event carries the run's fresh view (ticket, lane, agent, OpenCode
 * session, state); `ended` adds the outcome and the **target lane** the
 * orchestrator's lane order chose — which lane a finished run's ticket
 * belongs in is core's decision, and performing the move is the follower's.
 */
export type { RunEvent, RunEventListener } from '@aivi/host';
