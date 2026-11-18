/** The brand colours and the banner as a unit: what `brandStyle` hands to
 *  `styleText`, and how `brandBanner` lays the wordmark and the lines out for a
 *  stream that can, or cannot, show colour. The stream is the input: a writable
 *  that says whether it is a colour terminal. */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { BRAND, brandBanner, brandStyle } from '../src/brand.ts';

const BLUE = '\x1b[38;2;59;130;255m';
const AMBER = '\x1b[38;2;245;158;11m';
const GRAY = '\x1b[38;2;118;118;118m';
const CLOSE = '\x1b[39m';

/** A stream that is, or is not, a terminal with colour, whatever the environment says. */
function stream(t: TestContext, colour: boolean) {
  const kept = Object.fromEntries(
    ['FORCE_COLOR', 'NO_COLOR', 'NODE_DISABLE_COLORS'].map(key => [key, process.env[key]]),
  );
  for (const key of Object.keys(kept)) delete process.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(kept)) if (value !== undefined) process.env[key] = value;
  });
  const out = new Writable({ write: (_chunk, _encoding, done) => done() }) as Writable & {
    isTTY?: boolean;
    getColorDepth?: () => number;
  };
  if (colour) {
    out.isTTY = true;
    out.getColorDepth = () => 24;
  }
  return out;
}

const lines = [
  { text: 'aivi 1.0.0' },
  { text: 'always-on teammate', muted: true },
  { text: 'docs: aivi.ai', muted: true },
];

test('a colour terminal gets a hex colour as the colour, and a stream without colour gets the text', t => {
  assert.equal(brandStyle(BRAND.primary, 'aivi', stream(t, true)), `${BLUE}aivi${CLOSE}`);
  assert.equal(brandStyle(BRAND.primary, 'aivi', stream(t, false)), 'aivi');
});

test('a brand colour can be named instead of written as its hex', t => {
  const terminal = stream(t, true);

  assert.equal(brandStyle('primary', 'aivi', terminal), `${BLUE}aivi${CLOSE}`);
  assert.equal(brandStyle('remote', 'aivi', terminal), `${AMBER}aivi${CLOSE}`);
  assert.equal(brandStyle('muted', 'aivi', terminal), `${GRAY}aivi${CLOSE}`);
});

test('a list of formats mixes styleText’s own names with brand colours', t => {
  assert.equal(brandStyle(['bold', 'primary'], 'aivi', stream(t, true)), `\x1b[1m${BLUE}aivi${CLOSE}\x1b[22m`);
});

test('a stream without colour gets the lines alone, with no wordmark', t => {
  assert.equal(brandBanner(lines, stream(t, false)), 'aivi 1.0.0\nalways-on teammate\ndocs: aivi.ai');
});

test('a colour terminal gets the wordmark beside the lines, which run on below it', t => {
  const banner = brandBanner(lines, stream(t, true));

  assert.equal(
    stripVTControlCharacters(banner),
    ['  ▄▀█ █ █ █ █      aivi 1.0.0', '  █▀█ █ ▀▄▀ █      always-on teammate', '                   docs: aivi.ai'].join(
      '\n',
    ),
  );
});

test('the wordmark is blue, the title is plain and the other lines are gray', t => {
  const [first, second, third] = brandBanner(lines, stream(t, true)).split('\n');

  assert.equal(first, `  ${BLUE}▄▀█ █ █ █ █${CLOSE}      aivi 1.0.0`);
  assert.equal(second, `  ${BLUE}█▀█ █ ▀▄▀ █${CLOSE}      ${GRAY}always-on teammate${CLOSE}`);
  assert.equal(third, `                   ${GRAY}docs: aivi.ai${CLOSE}`);
});

test('a banner that answers someone else’s typed command has an amber wordmark', t => {
  const [first] = brandBanner(lines, stream(t, true), { remote: true }).split('\n');

  assert.equal(first, `  ${AMBER}▄▀█ █ █ █ █${CLOSE}      aivi 1.0.0`);
});

test('a banner with one line still draws the whole wordmark', t => {
  const banner = brandBanner([{ text: 'aivi' }], stream(t, true));

  assert.equal(stripVTControlCharacters(banner), ['  ▄▀█ █ █ █ █      aivi', '  █▀█ █ ▀▄▀ █'].join('\n'));
});

test('with no stream given the banner is drawn for stdout', () => {
  assert.equal(brandBanner(lines), brandBanner(lines, process.stdout));
});
