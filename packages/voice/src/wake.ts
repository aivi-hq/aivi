/** Mechanical wake-phrase scan over streaming text. No model, no semantics:
 *  normalize (lowercase, strip diacritics, collapse non-alphanumerics to
 *  single spaces) and look for a phrase as a whole-word run. The sentence
 *  itself is left as it was said: the phrase is how the agent knows it is
 *  being spoken to, so nothing is cut out of it.
 */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** First wake phrase heard in `text` (whole-word, normalized), or null. */
export function scanWake(text: string, phrases: string[]): string | null {
  const hay = ` ${normalize(text)} `;
  for (const phrase of phrases) {
    const needle = normalize(phrase);
    if (needle && hay.includes(` ${needle} `)) return phrase;
  }
  return null;
}
