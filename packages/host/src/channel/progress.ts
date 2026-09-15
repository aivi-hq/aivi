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

/** A codemode `execute` is shown as the aivi tools its code calls: `tools.knowledge.search({ query })` → `knowledge.search "…"`. */
const CALL = /tools\.((?:[\w-]+\.)+[\w-]+)\(/g;
const QUERY = /^\s*\{[^}]*?\bquery\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/;

/** Names and short details for one native tool call; `execute` may yield several, anything else exactly one. */
export function describeToolCall(name: string, input: Record<string, unknown>): { name: string; detail?: string }[] {
  if (name === 'execute') {
    const code = string(input.code);
    if (code) {
      const calls: { name: string; detail?: string }[] = [];
      for (const match of code.matchAll(CALL)) {
        const query = QUERY.exec(code.slice(match.index + match[0].length))?.[2];
        const call = { name: match[1]!, ...(query ? { detail: `"${truncate(query, DETAIL_MAX)}"` } : {}) };
        if (!calls.some(c => c.name === call.name && c.detail === call.detail)) calls.push(call);
      }
      if (calls.length) return calls;
    }
    return [{ name }];
  }
  const detail =
    name === 'webfetch'
      ? string(input.url) && hostname(string(input.url)!)
      : name === 'bash'
        ? string(input.command) && truncate(string(input.command)!.split('\n')[0]!, 40)
        : name === 'grep' || name === 'glob'
          ? string(input.pattern)
          : string(input.filePath) && basename(string(input.filePath)!);
  return [detail ? { name, detail: truncate(detail, DETAIL_MAX) } : { name }];
}

const data = (event: SessionEvent) => (event.data ?? {}) as Record<string, unknown>;

/** Fold one session event into the turn's progress; unknown events only count as activity. */
export function reduceProgress(state: Progress, event: SessionEvent, now: number): Progress {
  const next: Progress = { ...state, tools: [...state.tools], lastActivityAt: now };
  const d = data(event);
  const id = string(d.id);
  const running = () => next.tools.some(t => t.state === 'running');
  switch (event.type) {
    case 'session.tool.input.started': {
      if (id && !next.tools.some(t => t.id === id))
        next.tools.push({ id, name: string(d.name) ?? 'tool', state: 'running' });
      next.phase = 'tool';
      break;
    }
    case 'session.tool.called': {
      if (!id) break;
      const at = next.tools.findIndex(t => t.id === id);
      const name = at >= 0 ? next.tools[at]!.name : (string(d.name) ?? 'tool');
      const input = d.input && typeof d.input === 'object' ? (d.input as Record<string, unknown>) : {};
      const calls = describeToolCall(name, input).map(c => ({ id, ...c, state: 'running' as const }));
      if (at >= 0) next.tools.splice(at, 1, ...calls);
      else next.tools.push(...calls);
      next.phase = 'tool';
      break;
    }
    case 'session.tool.success':
    case 'session.tool.failed': {
      const state: ToolState = event.type === 'session.tool.success' ? 'done' : 'failed';
      next.tools = next.tools.map(t => (t.id === id ? { ...t, state } : t));
      next.phase = running() ? 'tool' : 'thinking';
      break;
    }
    case 'session.text.started':
    case 'session.text.delta': {
      if (!running()) next.phase = 'writing';
      break;
    }
    case 'session.step.started':
    case 'session.execution.started': {
      if (!running()) next.phase = 'thinking';
      break;
    }
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
};
const MARKS: Record<ToolState, string> = { running: '…', done: '✓', failed: '✗' };
const withDetail = (label: string, tool: ToolCall) => (tool.detail ? `${label} ${tool.detail}` : label);

/** The placeholder text: one status line, and in `tools` mode the last calls beneath it. */
export function renderProgress(
  state: Progress,
  mode: 'status' | 'tools',
  now: number,
  clock: ProgressClock = DEFAULT_CLOCK,
): string {
  const elapsed = now - state.startedAt;
  let head: string;
  if (now - state.lastActivityAt >= clock.idleMs) {
    head = `⏳ still working (${formatDuration(elapsed)})…`;
  } else {
    const current = state.tools.findLast(t => t.state === 'running');
    head =
      state.phase === 'writing'
        ? '✍️ writing the answer'
        : current
          ? `🔧 ${withDetail(VERBS[current.name] ?? current.name, current)}`
          : '⏳ thinking…';
    if (elapsed >= clock.longMs) {
      const n = state.tools.length;
      head += `${n ? ` · ${n} tool${n === 1 ? '' : 's'}` : ''} · ${formatDuration(elapsed)}`;
    }
  }
  if (mode === 'status') return head;
  const lines = state.tools.slice(-SHOWN_TOOLS).map(t => `${MARKS[t.state]} ${withDetail(t.name, t)}`);
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
