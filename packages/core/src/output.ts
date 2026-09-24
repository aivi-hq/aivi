import { inspect, stripVTControlCharacters, styleText } from 'node:util';

export type OutputBlock =
  /** One line of text. `indent` is in units of two spaces. */
  | { type: 'log'; text: string; indent?: number }
  | { type: 'heading'; text: string }
  | { type: 'divider' }
  | { type: 'table'; columns?: string[]; rows: string[][]; indent?: number }
  /** Raw JSON text: `JSON.stringify(value, null, 2)`, never colored. For output a
   *  person copies elsewhere, such as a Slack app manifest. */
  | { type: 'json'; value: unknown }
  /** Readable, colored `util.inspect` rendering of a value. For looking at, not
   *  copying: it is JS syntax, not JSON. What a terminal shows when a command has
   *  no hand-written rendering. */
  | { type: 'pretty'; value: unknown };

export type RenderOptions = {
  /** Whether bold and `pretty` colors may be emitted. `print` decides this once. */
  colors: boolean;
};

const NO_VALUE = 'N/A';
const COLUMN_GAP = '  ';

/**
 * Renders a stored timestamp — an ISO string or epoch milliseconds, whichever
 * the column holds — as a short date and time in the reader's own locale, so every
 * command writes the same shape. `N/A` when there is no timestamp yet: a job with
 * no next occurrence, a run that never finished. A value that is not a date is
 * returned as text rather than hidden.
 */
export function formatTimestamp(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return NO_VALUE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/** Width of a cell as a person sees it: styling escape codes take no space. */
function visibleWidth(text: string): number {
  return stripVTControlCharacters(text).length;
}

function bold(text: string, colors: boolean): string {
  // validateStream is off because `colors` was already decided from stdout.
  return colors ? styleText('bold', text, { validateStream: false }) : text;
}

function renderTable(block: Extract<OutputBlock, { type: 'table' }>, colors: boolean): string | null {
  const { columns, rows, indent = 0 } = block;
  const all = columns ? [columns, ...rows] : rows;
  const count = Math.max(0, ...all.map(row => row.length));
  if (count === 0) return null;

  const widths = Array.from({ length: count }, (_, i) => Math.max(...all.map(row => visibleWidth(row[i] ?? ''))));
  const prefix = '  '.repeat(indent);
  const line = (cells: string[]): string =>
    prefix +
    widths
      .map((width, i) => {
        const cell = cells[i] ?? '';
        return cell + ' '.repeat(width - visibleWidth(cell));
      })
      .join(COLUMN_GAP)
      .trimEnd();

  const lines = rows.map(line);
  if (columns) lines.unshift(line(columns.map(column => bold(column, colors))));
  return lines.join('\n');
}

function renderBlock(block: Exclude<OutputBlock, { type: 'divider' }>, options: RenderOptions): string | null {
  switch (block.type) {
    case 'log': {
      const prefix = '  '.repeat(block.indent ?? 0);
      return block.text
        .split('\n')
        .map(text => (text === '' ? '' : prefix + text))
        .join('\n');
    }
    case 'heading':
      return bold(block.text, options.colors);
    case 'table':
      return renderTable(block, options.colors);
    case 'json':
      return JSON.stringify(block.value, null, 2) ?? 'null';
    case 'pretty':
      return inspect(block.value, { depth: null, colors: options.colors });
  }
}

/**
 * Turns blocks into the text a terminal shows. Pure: no reading of `process`,
 * no writing. A divider is one empty line; consecutive dividers collapse to one
 * and a leading or trailing divider is dropped.
 */
export function renderOutput(blocks: OutputBlock[], options: RenderOptions): string {
  const parts: string[] = [];
  let dividerPending = false;
  for (const block of blocks) {
    if (block.type === 'divider') {
      dividerPending = parts.length > 0;
      continue;
    }
    const rendered = renderBlock(block, options);
    if (rendered === null) continue;
    if (dividerPending) parts.push('');
    parts.push(rendered);
    dividerPending = false;
  }
  return parts.join('\n');
}

/**
 * `data` is the machine form: every field, unchanged, printed as JSON whenever
 * stdout is not a terminal. `output` is what a person sees on a terminal, and is
 * optional: absent, a string renders as a `log` block and anything else as a
 * `pretty` block. A string `output` is one `log` block.
 */
export function print<T>(data: T, output?: OutputBlock[] | string): void {
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const blocks: OutputBlock[] =
    typeof output === 'string'
      ? [{ type: 'log', text: output }]
      : (output ?? (typeof data === 'string' ? [{ type: 'log', text: data }] : [{ type: 'pretty', value: data }]));
  // `hasColors` only exists when stdout is a TTY, and honors NO_COLOR,
  // NODE_DISABLE_COLORS, FORCE_COLOR and TERM=dumb.
  const rendered = renderOutput(blocks, { colors: process.stdout.hasColors?.() ?? false });
  if (rendered !== '') console.log(rendered);
}
