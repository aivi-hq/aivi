/**
 * The banner the thin CLI opens its help with. This is a copy of the brand
 * module in `@aivi/core` (the original keeps the wordmark and the hexes) —
 * the thin CLI ships without workspace dependencies, so it may not import
 * `@aivi/core`; it stands alone. Keep the two in sync.
 */
import { styleText } from 'node:util';

/** The brand blue and the one muted gray — the only colors the thin CLI uses. */
const BLUE = '#3B82FF';
const MUTED = '#767676';

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
 * terminals get plain text.
 */
export function brandBanner(lines: readonly BannerLine[], stream?: NodeJS.WritableStream): string {
  // Hex colors are valid styleText formats at runtime (Node 26.1+), but the
  // typings only accept them as the whole format — cast, as @aivi/core does.
  const paint = (hex: string, text: string): string =>
    styleText([hex] as Parameters<typeof styleText>[0], text, stream ? { stream } : {});
  const colored = paint(BLUE, '·') !== '·';
  if (!colored) return lines.map(line => line.text).join('\n');
  const width = Math.max(...WORDMARK.map(row => row.length));
  const out: string[] = [];
  for (let i = 0; i < Math.max(WORDMARK.length, lines.length); i++) {
    const mark = i < WORDMARK.length ? paint(BLUE, WORDMARK[i]!.padEnd(width)) : ' '.repeat(width);
    const line = lines[i];
    if (!line && i >= WORDMARK.length) continue;
    const text = line === undefined ? '' : i === 0 || !line.muted ? line.text : paint(MUTED, line.text);
    out.push(`  ${mark}      ${text}`.trimEnd());
  }
  return out.filter(row => row !== '').join('\n');
}
