/**
 * The face: the picture aivi shows whenever aivi needs a camera. One file,
 * one truth — the default ships inside this package (`face/index.html`, a
 * real page: `npx serve` that directory and the face appears), `aivi face
 * install` copies it to `<home>/face/index.html` and never overwrites, and
 * every meeting reads the file **at use**: an edit lands on the next
 * join, deleting the copy restores the built-in (the operator may break
 * their own face — allowed, warned, one `rm` from fixed).
 *
 * The face page and the media trick stay separate: the file is looks — a
 * self-contained script that paints a canvas and defines `window.aiviFace`;
 * the shim (see `face-tab.ts`) is the trick — it answers the meeting page's
 * device asks with the face canvas and aivi's own voice, and taps what the
 * page plays out loud. Both go into the page before its own scripts run
 * (`Page.addScriptToEvaluateOnNewDocument`), which is the whole reason a
 * consumer cannot open its own tab and do this: core opens the tab,
 * installs, navigates, and hands the raw `Tab` over. The consumer presses
 * its own platform's buttons; it never touches the face.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripPromptHeader } from './prompts.ts';

/** Where the default lives inside this package, relative to this module —
 *  the same relative path from `src/` (tests) and `dist/` (published). */
const PACKAGE_FACE = join(dirname(fileURLToPath(import.meta.url)), '..', 'face', 'index.html');

/** What every installed copy opens with, so the file says how to leave it. */
export const FACE_WARNING =
  '<!-- aivi: this face is yours to edit — every camera aivi shows wears it. ' +
  'Keep the one inline <script> and its window.aiviFace contract (see its ' +
  'header). Delete this file to get the built-in back. -->\n\n';

/** The built-in face, read from the package file. Grows only by ruling. */
export async function defaultFaceHtml(): Promise<string> {
  return readFile(PACKAGE_FACE, 'utf8');
}

export interface FaceInstall {
  /** Copied now, because the home had no file. */
  written: boolean;
  /** Already there: the operator's own face is never overwritten. */
  kept: boolean;
}

/** Install the editable copy into `<home>/face/index.html`, never overwriting. */
export async function installFace(home: string): Promise<FaceInstall> {
  const path = join(home, 'face', 'index.html');
  try {
    await readFile(path);
    return { written: false, kept: true };
  } catch {
    // No file yet: the copy goes in below. Anything else than absence
    // would surface from the write itself.
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${FACE_WARNING}${await defaultFaceHtml()}`);
  return { written: true, kept: false };
}

/** The face in use: the home's file when it holds words, the built-in
 *  otherwise. Missing, unreadable or emptied all say "give me the default
 *  back", and none is an error. Read at use — every call, every meeting. */
export async function readFaceHtml(home: string): Promise<string> {
  try {
    const text = stripPromptHeader(await readFile(join(home, 'face', 'index.html'), 'utf8'));
    return text || (await defaultFaceHtml());
  } catch {
    return defaultFaceHtml();
  }
}

/** The face's one inline script — the part that gets injected. The file is
 *  HTML for humans; a page wants the script. A face without a usable
 *  script is said by name: it is the operator's file, and the fix is in
 *  the message. */
export function faceScriptSource(html: string): string {
  const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const body = match?.[1]?.trim();
  if (!body) {
    throw new Error(
      'the face has no inline <script> to run: keep one script that defines window.aiviFace (see the built-in)',
    );
  }
  return body;
}
