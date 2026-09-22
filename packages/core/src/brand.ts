import { styleText } from 'node:util';

/**
 * The brand palette — the same hexes log.ts hands LogTape, so a terminal that
 * watches aivi's help and aivi's logs hears one voice. Color goes through
 * `styleText`, which decides per stream: a pipe, a NO_COLOR terminal or a dumb
 * TERM gets the same words, plain, because stdout stays a machine contract.
 */
export const BRAND = {
  /** The aivi blue: the wordmark, command and option names in help. */
  primary: '#3B82FF',
  /** The one muted gray: help titles, secondary lines, the dreaming category. */
  muted: '#767676',
  discord: '#a371f7',
  slack: '#36c5f0',
  linear: '#5e6ad2',
  knowledge: '#C69214',
} as const;

export type BrandColor = keyof typeof BRAND;

/**
 * The wordmark. Four letters, two rows of block characters, drawn by hand —
 * a logo library would cost megabytes to say less.
 */
export const WORDMARK = ['▄▀█ █ █ █ █', '█▀█ █ ▀▄▀ █'] as const;

/**
 * Style one string with brand colors. `formats` is any styleText format list —
 * a BrandColor name, or `['bold', BRAND.muted]`. With a stream, color support
 * is validated against that stream; without one, against stdout, which is what
 * commander's own detection keys off too.
 */
export function brandStyle(
  formats: BrandColor | string | readonly string[],
  text: string,
  stream?: NodeJS.WritableStream,
): string {
  const list = typeof formats === 'string' ? [formats] : formats;
  // Hex codes are valid styleText formats at runtime (verified on Node 26), but
  // the typings only allow them as the whole format, not inside an array.
  return styleText(list as Parameters<typeof styleText>[0], text, stream ? { stream } : {});
}

/** One right-hand line of the banner; the first is the title, the rest muted. */
export interface BannerLine {
  text: string;
  muted?: boolean;
}

/**
 * The banner: the wordmark left, the caller's lines right, so `aivi --help`
 * opens with a face instead of a wall. On a stream without color the mark is
 * decoration only and goes — pipes and NO_COLOR terminals get plain text.
 */
export function brandBanner(lines: readonly BannerLine[], stream?: NodeJS.WritableStream): string {
  // One styled probe tells whether this stream wants color at all: a styled
  // empty-ish marker comes back unchanged when it does not.
  const colored = brandStyle(BRAND.primary, '·', stream) !== '·';
  if (!colored) return lines.map(line => line.text).join('\n');
  const width = Math.max(...WORDMARK.map(row => row.length));
  const out: string[] = [];
  for (let i = 0; i < Math.max(WORDMARK.length, lines.length); i++) {
    const mark =
      i < WORDMARK.length ? brandStyle(BRAND.primary, WORDMARK[i]!.padEnd(width), stream) : ' '.repeat(width);
    const line = lines[i];
    if (!line && i >= WORDMARK.length) continue;
    const text =
      line === undefined ? '' : i === 0 || !line.muted ? line.text : brandStyle(BRAND.muted, line.text, stream);
    out.push(`  ${mark}      ${text}`.trimEnd());
  }
  return out.filter(row => row !== '').join('\n');
}
