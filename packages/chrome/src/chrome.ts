/**
 * The browser itself: launch the installed Chrome as our child, or attach to
 * one somebody else started, and hand out tabs.
 *
 * Chrome 136 and later ignore `--remote-debugging-port` on the default
 * profile, so a launch always carries its own `--user-data-dir` — which is
 * also what lets several aivi browsers sit side by side, and keeps the
 * operator's own browser out of it. We ask for port 0 and read the real port
 * from the `DevToolsActivePort` file Chrome writes in the profile, so two
 * launches never fight over a number.
 *
 * The default flags are the ones proven on real Meet screens: camera and mic
 * prompts answer themselves, WebGL paints without a GPU, nothing waits for a
 * human gesture. Further flags append after them.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { CdpConnection, sleep } from './connection.ts';
import { Tab } from './tab.ts';

/** Usual install paths per platform, after the `AIVI_CHROME_PATH`
 *  environment variable. No Windows: aivi's hosts are mac and linux. */
const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

const PATH_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

const DEFAULT_ARGS = [
  '--use-fake-ui-for-media-stream', // the camera and mic prompts answer themselves
  '--autoplay-policy=no-user-gesture-required',
  '--enable-unsafe-swiftshader', // WebGL without a GPU: the face is a WebGL canvas
  '--disable-blink-features=AutomationControlled', // navigator.webdriver reads false, like a normal browser (CDP otherwise sets it true, and conferencing pages read it)
  // the face animates on requestAnimationFrame, and Chrome throttles that
  // clock for windows sitting behind others — the meeting tile froze on
  // the last frame while our window was occluded (real meeting,
  // 2026-10-14). These two flags keep our own window's clock honest.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=1280,720',
  '--lang=en-US',
];

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

/** Find the browser binary: `AIVI_CHROME_PATH` if set (a set-but-wrong value
 *  is a loud error, not a silent miss), then the usual paths, then PATH.
 *  Undefined means no browser found; the caller decides what that means. */
export function findChrome(): string | undefined {
  const fromEnv = process.env.AIVI_CHROME_PATH;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!existsSync(fromEnv)) throw new Error(`AIVI_CHROME_PATH points at nothing: ${fromEnv}`);
    return fromEnv;
  }
  const known = [...(CANDIDATES[process.platform] ?? [])];
  for (const name of PATH_NAMES) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir !== '' && existsSync(join(dir, name))) known.push(join(dir, name));
    }
  }
  return known.find(path => existsSync(path));
}

export interface ChromeLaunchOptions {
  /** A directory for this browser alone. Chrome refuses its debug port on
   *  the default profile, so this is not optional; a throwaway one is fine
   *  and `rm` then cleans up. */
  profileDir: string;
  /** Skip the search and say which binary to run. */
  executablePath?: string;
  /** Default true: `--headless=new`, the mode proven on the face route. */
  headless?: boolean;
  /** Appended after the default flags. */
  args?: string[];
  /** How long the browser gets to boot and answer. Default 20000. */
  startupTimeoutMs?: number;
  commandMaxTime?: number;
}

export interface ChromeAttachOptions {
  /** Base URL of a browser already started with `--remote-debugging-port`.
   *  Default `http://127.0.0.1:9222`. */
  debugUrl?: string;
  /** The websocket URL straight from `/json/version`, when discovery is
   *  already done. */
  wsUrl?: string;
  /** How long to wait for the answer. Default 20000. */
  timeoutMs?: number;
  commandMaxTime?: number;
}

interface VersionInfo {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitCodeOf(child: ChildProcess): string {
  return child.exitCode !== null ? String(child.exitCode) : (child.signalCode ?? '?');
}

/** Wait for the port file Chrome writes in the profile, watching the process
 *  so a browser that dies on a bad flag fails here with its code, not with a
 *  timeout much later. */
async function readActivePort(portFile: string, child: ChildProcess, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const port = Number((await readFile(portFile, 'utf8')).split('\n')[0]?.trim());
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {
      // Chrome has not written the file yet
    }
    if (exited(child)) {
      throw new Error(`chrome exited before reporting a port (code ${exitCodeOf(child)}) — check the flags`);
    }
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`no DevToolsActivePort in the profile within ${timeoutMs} ms`);
}

/** Ask `/json/version` until it answers, watching the process when there is
 *  one. The websocket URL is the browser's own — we never build it. */
async function discoverVersion(
  baseUrl: string,
  deadline: number,
  child: ChildProcess | undefined,
): Promise<VersionInfo> {
  do {
    try {
      const response = await fetch(`${baseUrl}/json/version`);
      if (response.ok) {
        const info = (await response.json()) as VersionInfo;
        if (info.webSocketDebuggerUrl !== undefined) return info;
      }
    } catch {
      // nothing listening yet
    }
    if (child !== undefined && exited(child)) {
      throw new Error(`chrome exited before answering /json/version (code ${exitCodeOf(child)})`);
    }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`the browser at ${baseUrl} never answered /json/version`);
}

/** SIGTERM so Chrome can flush the profile, SIGKILL only if it ignores
 *  that. One bounded wait either way. */
async function killChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
  });
}

export class Chrome {
  readonly connection: CdpConnection;
  /** The browser's own version string, e.g. `Chrome/141.0.7390.107`. */
  readonly browser: string;
  /** The debug port, so an attach or a status line can name it. */
  readonly port: number;
  readonly #child: ChildProcess | undefined;
  #closed = false;

  private constructor(connection: CdpConnection, info: VersionInfo, port: number, child: ChildProcess | undefined) {
    this.connection = connection;
    this.browser = info.Browser ?? 'unknown';
    this.port = port;
    this.#child = child;
  }

  /** Launch the installed Chrome as a child of this process. */
  static async launch(options: ChromeLaunchOptions): Promise<Chrome> {
    const bin = options.executablePath ?? findChrome();
    if (bin === undefined) throw new Error('no Chrome binary found — install Chrome or set AIVI_CHROME_PATH');
    if (options.profileDir === '')
      throw new Error('launch needs its own profileDir (Chrome ignores the debug port on the default profile)');
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    await mkdir(options.profileDir, { recursive: true });
    const portFile = join(options.profileDir, 'DevToolsActivePort');
    // a file from an earlier run would advertise a dead port
    await rm(portFile, { force: true });
    const flags = [
      ...((options.headless ?? true) ? ['--headless=new'] : []),
      `--user-data-dir=${options.profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      ...DEFAULT_ARGS,
      ...(options.args ?? []),
      // headless Chrome exits when its last tab closes, so one stays open
      'about:blank',
    ];
    const child = spawn(bin, flags, { stdio: 'ignore' });
    try {
      const port = await readActivePort(portFile, child, startupTimeoutMs);
      const info = await discoverVersion(`http://127.0.0.1:${port}`, Date.now() + startupTimeoutMs, child);
      const connection = await CdpConnection.open(info.webSocketDebuggerUrl ?? '', {
        ...(options.commandMaxTime === undefined ? {} : { commandMaxTime: options.commandMaxTime }),
      });
      return new Chrome(connection, info, port, child);
    } catch (error) {
      await killChild(child);
      throw error;
    }
  }

  /** Take over a browser somebody else started with
   *  `--remote-debugging-port`. `close()` disconnects and leaves it running —
   *  it is not ours to kill. */
  static async attach(options: ChromeAttachOptions = {}): Promise<Chrome> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let info: VersionInfo = {};
    let wsUrl = options.wsUrl;
    if (wsUrl === undefined) {
      const baseUrl = options.debugUrl ?? 'http://127.0.0.1:9222';
      info = await discoverVersion(baseUrl, Date.now() + timeoutMs, undefined);
      wsUrl = info.webSocketDebuggerUrl ?? '';
    }
    // the answer carries the real host and port, so trust it over the question
    const port = Number(new URL(wsUrl).port);
    const connection = await CdpConnection.open(wsUrl, {
      ...(options.commandMaxTime === undefined ? {} : { commandMaxTime: options.commandMaxTime }),
    });
    return new Chrome(connection, info, port, undefined);
  }

  /** True when this handle launched the browser and owns ending it. */
  get launched(): boolean {
    return this.#child !== undefined;
  }

  /** Notice the browser going away on its own — a crash, or a hand at the
   *  Activity Monitor. The listener fires once when the connection dies;
   *  our own `close()` does not count. A caller holding live state in the
   *  page (a meeting) uses this to say the state is over instead of
   *  knocking on a dead browser forever. */
  onGone(listener: () => void): void {
    this.connection.addEventListener(
      'close',
      () => {
        if (!this.#closed) listener();
      },
      { once: true },
    );
  }

  /** Open a tab, blank on purpose: the caller installs its scripts before
   *  the first navigation — `tab.send('Page.addScriptToEvaluateOnNewDocument',
   *  ...)`, then `tab.goto(url)` — which is the whole face trick. */
  async newTab(): Promise<Tab> {
    const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    return new Tab(this.connection, targetId, sessionId);
  }

  /** Disconnect, and end the browser when we launched it. An attached browser
   *  keeps running. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.connection.close();
    if (this.#child !== undefined) await killChild(this.#child);
  }
}
