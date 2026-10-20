/** Mechanical wake-phrase scan over streaming text. No model, no semantics:
 *  normalize (lowercase, strip diacritics, collapse non-alphanumerics to
 *  single spaces) and look for a phrase as a whole-word run. Phrase hits are
 *  reported against the raw text they were found in, so the caller can cut
 *  the phrase out of the sentence it was addressed with.
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

/** Remove one occurrence of the wake phrase from raw text (the words the
 *  person said to aivi, minus the address). Falls back to the raw text. */
export function stripWake(text: string, phrase: string): string {
  const re = new RegExp(
    `\\b${normalize(phrase)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/ /g, '\\s+')}\\b`,
    'i',
  );
  const cut = text
    .replace(re, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
  return cut || text.trim();
}
