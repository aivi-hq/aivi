/** The parts of GitHub's delivery payloads the tracker reads — all of it
 *  **untrusted input**, parsed only after the seal verified. GitHub names the
 *  event in the `X-GitHub-Event` header, not in the body, and deduplicates
 *  redeliveries by `X-GitHub-Delivery`: the same id may arrive twice, and the
 *  second must land as nothing.
 *
 *  What deliberately is **not** read: `ping` (the settings page's hello),
 *  `installation` events (noise on permission changes, live 2026-10-07),
 *  `projects_v2_item` `reordered` (one per board drag, no routing meaning),
 *  and `issues.assigned` — an **assignee** is a person's label on GitHub;
 *  the delegate lives in the board's `Agent` field (D5).
 */

/** The delivery headers every GitHub webhook carries. Delivery ids exceed
 *  2^53 (live, 2026-10-07) — they are strings here and nowhere a number. */
export interface GithubDeliveryHeaders {
  event: string | undefined;
  delivery: string | undefined;
  signature: string | undefined;
}

export const GITHUB_EVENT_HEADER = 'x-github-event';
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';

/** The comment author as GitHub answers it: `Bot` is an app, and aivi's own
 *  posts — the status comment, closings, questions — are how a run speaks.
 *  Inbound, every `Bot` post is filtered: aivi never answers itself. */
export const isBotAuthor = (user: { type?: string | null } | undefined | null): boolean => user?.type === 'Bot';

/** An `issue_comment` delivery: a person's message inside a ticket. */
export interface IssueCommentPayload {
  action: string;
  comment: { id: number; body: string | null; user: { login: string; type?: string } | null };
  issue: { number: number };
  repository: { full_name: string };
}

/** An `issues` delivery: the ticket itself changed. */
export interface IssuesPayload {
  action: string;
  number: number;
  label?: { name: string };
  repository: { full_name: string };
}

/** A `projects_v2_item` delivery: the board moved the ticket or changed a
 *  field on it. The content arrives as a GraphQL node id — the ref behind it
 *  is one lookup away (`client.nodeRef`). */
export interface ProjectsV2ItemPayload {
  action: string;
  project_node_id: string;
  changes?: {
    field_name?: string;
    field_value?: { from?: string; to?: string; field_name?: string };
  };
  projects_v2_item: { content: { node_id: string | null } | null };
}

/** The field a `projects_v2_item` edit changed, however GitHub spelled the
 *  delivery that day: `changes.field_name` per the docs, and the probe
 *  (live, 2026-10-07) saw it under `changes.field_value.field_name` too.
 *  Both readings, or a silent miss on every lane move. */
export const editedFieldName = (changes: ProjectsV2ItemPayload['changes']): string | undefined =>
  changes?.field_name ?? changes?.field_value?.field_name;

/** Redeliveries by delivery id, bounded. GitHub resends the same id when a
 *  reply was lost; the second sight must not run the handler twice. Oldest
 *  falls out first — a window of a thousand deliveries is days of traffic. */
export class DeliveryLedger {
  private readonly seen = new Set<string>();
  private readonly capacity: number;
  constructor(capacity = 1024) {
    this.capacity = capacity;
  }

  /** True the **first** time an id is named; every later sight says nothing. */
  fresh(delivery: string): boolean {
    if (this.seen.has(delivery)) return false;
    this.seen.add(delivery);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
    return true;
  }
}
