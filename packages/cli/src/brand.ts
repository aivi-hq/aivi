/**
 * The banner the CLI opens its help with. This is a copy of the brand
 * module in `@aivi/core` (the original keeps the wordmark and the hexes) —
 * the CLI ships without workspace dependencies, so it may not import
 * `@aivi/core`; it stands alone. Keep the two in sync.
 */
import { styleText } from 'node:util';

/** The brand blue, the one muted gray, and the caution amber — the only
 *  colors the CLI uses. Amber marks a banner answering someone else's typed
 *  command: the exec door's child carries the machine fact, and the letter-
 *  mark says so on the streamed page. */
const BLUE = '#3B82FF';
const MUTED = '#767676';
const AMBER = '#F59E0B';

/** The wordmark; `@aivi/core` owns the drawing. */
const WORDMARK = ['▄▀█ █ █ █ █', '█▀█ █ ▀▄▀ █'];

/** One right-hand line of the banner; the first is the title, the rest muted. */
export interface BannerLine {
  text: string;
  muted?: boolean;
}

/**
 * The banner: the wordmark left, the caller's lines right. On a stream
 * without color the mark is decoration only and goes — pipes and NO_COLOR
 * terminals get plain text. `remote` draws the lettermark in caution amber;
 * the title's `(remote)` word is the caller's own text, so it survives even
 * where color cannot.
 */
export function brandBanner(
  lines: readonly BannerLine[],
  stream?: NodeJS.WritableStream,
  options: { remote?: boolean } = {},
): string {
  // Hex colors are valid styleText formats at runtime (Node 26.1+), but the
  // typings only accept them as the whole format — cast, as @aivi/core does.
  const paint = (hex: string, text: string): string =>
    styleText([hex] as Parameters<typeof styleText>[0], text, stream ? { stream } : {});
  const colored = paint(BLUE, '·') !== '·';
  if (!colored) return lines.map(line => line.text).join('\n');
  const width = Math.max(...WORDMARK.map(row => row.length));
  const mark = options.remote === true ? AMBER : BLUE;
  const out: string[] = [];
  for (let i = 0; i < Math.max(WORDMARK.length, lines.length); i++) {
    const glyph = i < WORDMARK.length ? paint(mark, WORDMARK[i]!.padEnd(width)) : ' '.repeat(width);
    const line = lines[i];
    if (!line && i >= WORDMARK.length) continue;
    const text = line === undefined ? '' : i === 0 || !line.muted ? line.text : paint(MUTED, line.text);
    out.push(`  ${glyph}      ${text}`.trimEnd());
  }
  return out.filter(row => row !== '').join('\n');
}
