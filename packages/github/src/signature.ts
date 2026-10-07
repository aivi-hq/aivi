/** The signature aivi closes its own posts with, and the reading of it.
 *
 *  A forge that hands a worker "everything the review said" must be able to
 *  tell its own past comments from a human's — and the carrier has to be one a
 *  person reads too, because the reviewer is a person. So the label is visible
 *  text closing the comment, not hidden markup: a divider and an italic line.
 *  The exact look is what the live gate will judge; what is settled is that
 *  the same bytes serve both readers.
 */

/** What the label says aivi's own name is, ahead of the worker role. */
const BRAND = 'aivi · ';

/** The label, as it closes a comment aivi posted: `_worker: aivi · review_`. */
const LABEL = /^_worker:\s*(.+?)\s*_$/;

/**
 * Close a comment with the worker role that wrote it. Every post aivi makes to
 * a person-facing thread carries this, so a reviewer always knows the words
 * came from a worker and not from the operator driving it.
 */
export function signComment(body: string, worker: string): string {
  return `${body.trimEnd()}\n\n---\n\n_worker: ${BRAND}${worker}_`;
}

/**
 * Read the worker role back out of a comment body, or undefined for anything
 * aivi did not write. Only the **last line** is read: the label closes a
 * comment, so a `_worker: …_` quoted in the middle of someone's reply is that
 * person's text, not a fact about who wrote the reply.
 */
export function parseWorker(body: string): string | undefined {
  const lines = body.trimEnd().split('\n');
  const last = lines.at(-1);
  if (!last) return undefined;
  const label = LABEL.exec(last.trim())?.[1];
  if (!label) return undefined;
  return label.startsWith(BRAND) ? label.slice(BRAND.length).trim() : label;
}
