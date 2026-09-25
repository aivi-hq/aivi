import { basename } from 'node:path';
import type { SessionEvent } from '../events.ts';

export type ProgressMode = 'silent' | 'status' | 'tools';
export type ToolState = 'running' | 'done' | 'failed';
export interface ToolCall {
  /** The native tool call id; several entries share one when a codemode `execute` calls several aivi tools. */
  id: string;
  name: string;
  detail?: string;
  state: ToolState;
  /** A codemode `execute` whose code has not arrived yet: the real tool name is unknown, so it stays out of the status line. */
  pending?: true;
}
export interface Progress {
  phase: 'thinking' | 'tool' | 'writing';
  tools: ToolCall[];
  startedAt: number;
  lastActivityAt: number;
}

/** The instants at which the text changes without an event; tests shrink them. */
export interface ProgressClock {
  /** After this long the status line carries the tool count and elapsed time. */
  longMs: number;
  /** Without any event for this long the status line says so. */
  idleMs: number;
  /** Once the elapsed time shows, how often it is refreshed. */
  refreshMs: number;
}
export const DEFAULT_CLOCK: ProgressClock = { longMs: 20_000, idleMs: 30_000, refreshMs: 30_000 };
const SHOWN_TOOLS = 8;
const DETAIL_MAX = 60;

export function startProgress(now: number): Progress {
  return { phase: 'thinking', tools: [], startedAt: now, lastActivityAt: now };
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const string = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * A codemode `execute` is shown as the aivi tools its code calls: `tools.knowledge.search({ query })`
 * → `knowledge.search "…"`. Dotted and bracket notation both count (`tools.aivi["context"]()`), as
 * does a destructured namespace (`const { aivi } = tools; aivi.context()`).
 */
const SEGMENT = String.raw`(?:\.[\w-]+|\[["'][\w-]+["']\])`;
const CALL = new RegExp(String.raw`\btools(${SEGMENT}+)\(`, 'g');
const DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*tools\b/g;
const QUERY = /^\s*\{[^}]*?\bquery\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/;
const dotted = (path: string) => path.replaceAll(/\[["']([\w-]+)["']\]/g, '.$1').replace(/^\./, '');

type ToolDescription = { name: string; detail?: string };

/** The aivi tools a codemode `execute`'s code calls, in call order, each shown once. */
function codemodeCalls(code: string): ToolDescription[] {
  const calls: ToolDescription[] = [];
  const add = (name: string, rest: string) => {
    const query = QUERY.exec(rest)?.[2];
    const call: ToolDescription = { name, ...(query ? { detail: `"${truncate(query, DETAIL_MAX)}"` } : {}) };
    if (!calls.some(c => c.name === call.name && c.detail === call.detail)) calls.push(call);
  };
  for (const match of code.matchAll(CALL)) add(dotted(match[1]!), code.slice(match.index + match[0].length));
  for (const { alias, namespace } of destructuredNamespaces(code)) {
    const local = new RegExp(String.raw`\b${alias}(${SEGMENT}+)\(`, 'g');
    for (const call of code.matchAll(local)) {
      const path = dotted(call[1]!);
      add(`${namespace}${path ? `.${path}` : ''}`, code.slice(call.index + call[0].length));
    }
  }
  return calls;
}

/** Namespaces destructured from `tools` (`const { aivi, knowledge: k } = tools`): the local name and
 *  the namespace it calls through. A local that is not a plain identifier is skipped — it would be
 *  a regex injection. */
function destructuredNamespaces(code: string): { alias: string; namespace: string }[] {
  const found: { alias: string; namespace: string }[] = [];
  for (const match of code.matchAll(DESTRUCTURE))
    for (const raw of match[1]!.split(',')) {
      const parts = raw.split(':');
      const alias = parts.at(-1)!.trim();
      if (alias && /^[\w$]+$/.test(alias)) found.push({ alias, namespace: parts[0]!.trim() });
    }
  return found;
}

/** The short detail a native tool's status line carries: what it touched, not the whole input. */
function toolDetail(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'webfetch': {
      const url = string(input.url);
      return url && hostname(url);
    }
    case 'bash': {
      const command = string(input.command);
      return command && truncate(command.split('\n')[0]!, 40);
    }
    case 'grep':
    case 'glob':
      return string(input.pattern);
    default: {
      const path = string(input.filePath);
      return path && basename(path);
    }
  }
}

/** Names and short details for one native tool call; `execute` may yield several, anything else exactly one. */
export function describeToolCall(name: string, input: Record<string, unknown>): ToolDescription[] {
  if (name === 'execute') {
    const code = string(input.code);
    const calls = code ? codemodeCalls(code) : [];
    return calls.length ? calls : [{ name }];
  }
  const detail = toolDetail(name, input);
  return [detail ? { name, detail: truncate(detail, DETAIL_MAX) } : { name }];
}

const data = (event: SessionEvent) => (event.data ?? {}) as Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
const toolState = (status: unknown): ToolState =>
  status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'running';

/** OpenCode's `session.tool.progress` names the aivi tools a codemode `execute` runs, with their
 *  status: authoritative, no parsing. The wrapper entry becomes one entry per named tool, in place,
 *  keeping the details already shown. Reports whether anything changed. */
function applyNamedCalls(next: Progress, id: string, metadata: Record<string, unknown>): boolean {
  const calls = Array.isArray(metadata.toolCalls)
    ? (metadata.toolCalls as { tool?: unknown; status?: unknown }[]).filter(c => typeof c.tool === 'string')
    : [];
  if (!calls.length) return false;
  const at = next.tools.findIndex(t => t.id === id);
  const named = calls.map(c => {
    const existing = next.tools.find(t => t.id === id && t.name === c.tool);
    const state = toolState(c.status);
    return { id, name: c.tool as string, ...(existing?.detail ? { detail: existing.detail } : {}), state };
  });
  const others = next.tools.filter(t => t.id !== id);
  next.tools = at >= 0 ? [...others.slice(0, at), ...named, ...others.slice(at)] : [...others, ...named];
  return true;
}

/** `session.tool.called` carries the input: the entry becomes the tool(s) it names, all running. */
function applyToolCalled(next: Progress, id: string, d: Record<string, unknown>): void {
  const at = next.tools.findIndex(t => t.id === id);
  const name = at >= 0 ? next.tools[at]!.name : (string(d.name) ?? 'tool');
  const calls = describeToolCall(name, record(d.input) ?? {}).map(c => ({ id, ...c, state: 'running' as const }));
  if (at >= 0) next.tools.splice(at, 1, ...calls);
  else next.tools.push(...calls);
}

/** A tool call begins; Code Mode's `execute` wrapper stays nameless until its code arrives. */
function startedTool(next: Progress, d: Record<string, unknown>, id: string | undefined): void {
  if (id && !next.tools.some(t => t.id === id)) {
    const name = string(d.name) ?? 'tool';
    next.tools.push(
      name === 'execute' ? { id, name, state: 'running', pending: true } : { id, name, state: 'running' },
    );
  }
}

/** The call ends: an `execute` whose code only travelled with the result is named here, entries for
 *  the id take the final state, and the phase follows whatever is still running. */
function finishEvent(next: Progress, d: Record<string, unknown>, id: string | undefined, ok: boolean): void {
  const state: ToolState = ok ? 'done' : 'failed';
  const input = record(d.input);
  if (id) {
    const at = next.tools.findIndex(t => t.id === id && t.name === 'execute');
    if (input && at >= 0)
      next.tools.splice(at, 1, ...describeToolCall('execute', input).map(c => ({ id, ...c, state })));
    next.tools = next.tools.map(t => {
      if (t.id !== id) return t;
      const { pending: _pending, ...rest } = t;
      return { ...rest, state };
    });
  }
  next.phase = next.tools.some(t => t.state === 'running') ? 'tool' : 'thinking';
}

/** Fold one session event into the turn's progress; unknown events only count as activity. */
export function reduceProgress(state: Progress, event: SessionEvent, now: number): Progress {
  const next: Progress = { ...state, tools: [...state.tools], lastActivityAt: now };
  const d = data(event);
  const id = string(d.id);
  const running = () => next.tools.some(t => t.state === 'running');
  switch (event.type) {
    case 'session.tool.input.started':
      startedTool(next, d, id);
      next.phase = 'tool';
      break;
    case 'session.tool.progress':
      if (id && applyNamedCalls(next, id, record(d.metadata) ?? {}) && running()) next.phase = 'tool';
      break;
    case 'session.tool.called':
      if (id) {
        applyToolCalled(next, id, d);
        next.phase = 'tool';
      }
      break;
    case 'session.tool.success':
    case 'session.tool.failed':
      finishEvent(next, d, id, event.type === 'session.tool.success');
      break;
    case 'session.text.started':
    case 'session.text.delta':
      if (!running()) next.phase = 'writing';
      break;
    case 'session.step.started':
    case 'session.execution.started':
      if (!running()) next.phase = 'thinking';
      break;
    default:
      break;
  }
  return next;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const VERBS: Record<string, string> = {
  read: 'reading',
  grep: 'searching',
  glob: 'searching',
  list: 'listing',
  webfetch: 'fetching',
  bash: 'running',
  edit: 'editing',
  write: 'writing',
  'knowledge.search': 'searching knowledge',
  'knowledge.projects': 'listing projects',
  'aivi.sources': 'listing sources',
  'aivi.status': 'checking status',
  'aivi.context': 'reading the context',
  'aivi.jobs': 'scheduling',
  'aivi.browser': 'browsing',
};
const MARKS: Record<ToolState, string> = { running: '…', done: '✓', failed: '✗' };
const withDetail = (label: string, tool: ToolCall) => (tool.detail ? `${label} ${tool.detail}` : label);

/** The status line: what the turn is doing; once it runs long, the tool count and elapsed time join in. */
function statusLine(state: Progress, now: number, clock: ProgressClock): string {
  const elapsed = now - state.startedAt;
  if (now - state.lastActivityAt >= clock.idleMs) return `⏳ still working (${formatDuration(elapsed)})…`;
  const current = state.tools.findLast(t => t.state === 'running' && !t.pending);
  let head: string;
  if (state.phase === 'writing') head = '✍️ writing the answer';
  else if (current) head = `🔧 ${withDetail(VERBS[current.name] ?? current.name, current)}`;
  else head = '⏳ thinking…';
  if (elapsed >= clock.longMs) {
    const n = state.tools.length;
    head += `${n ? ` · ${n} tool${n === 1 ? '' : 's'}` : ''} · ${formatDuration(elapsed)}`;
  }
  return head;
}

/** The placeholder text: one status line, and in `tools` mode the last calls beneath it. */
export function renderProgress(
  state: Progress,
  mode: 'status' | 'tools',
  now: number,
  clock: ProgressClock = DEFAULT_CLOCK,
): string {
  const head = statusLine(state, now, clock);
  if (mode === 'status') return head;
  const lines = state.tools
    .filter(t => !t.pending)
    .slice(-SHOWN_TOOLS)
    .map(t => `${MARKS[t.state]} ${withDetail(t.name, t)}`);
  return [head, ...lines].join('\n');
}

/**
 * The next instant the rendered text changes with no event at all: the long-turn
 * suffix appearing, the idle notice, then each refresh of the elapsed time.
 * The reporter waits for that instant rather than polling.
 */
export function nextRenderChange(state: Progress, now: number, clock: ProgressClock = DEFAULT_CLOCK): number {
  const candidates = [state.startedAt + clock.longMs, state.lastActivityAt + clock.idleMs].filter(t => t > now);
  const elapsed = now - state.startedAt;
  if (elapsed >= clock.longMs)
    candidates.push(state.startedAt + (Math.floor(elapsed / clock.refreshMs) + 1) * clock.refreshMs);
  return Math.min(...candidates);
}
