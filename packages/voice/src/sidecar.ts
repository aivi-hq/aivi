/** What the engine sidecars' clients share: every engine speaks JSONL on
 *  stdout, one protocol message per line. */

/** One stdout line as a protocol message. Every message is a JSON object:
 *  anything else is a bad line before a single field is looked at. Throws
 *  for a line that is not one. */
export function objectMessage(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('an engine message must be an object');
  return value as Record<string, unknown>;
}
