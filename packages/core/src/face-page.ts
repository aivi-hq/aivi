/**
 * Everything in this file runs inside the face page, not in Node.
 * `face-tab.ts` sends the source text of one of these functions through
 * `tab.call` or `tab.waitFor`, so a function here closes over nothing: no
 * import, no constant of this module, no other function of this file. Data
 * goes in as arguments, and only plain values come back.
 */

/** The face page as these functions reach it. This declaration is
 *  compile-time only: the bytes that travel carry plain `window` accesses,
 *  and the names are exactly the globals the shim and the face script of
 *  `face-tab.ts` install. */
declare const window: {
  aiviFace?: { setState(name: string, detail?: unknown): void };
  __aiviMic: {
    /** Resolves in-page: true when the wav played through, false when a stop cut it. */
    play(b64: string): boolean;
    stopAll(): void;
  };
  __aiviTap?: boolean;
  __aiviMute?: (on: boolean) => void;
};

/** True once the face script has put its object on the page. */
export const faceIsUp = () => typeof window.aiviFace === 'object';

export const setFace = (name: string) => window.aiviFace?.setState(name);

export const setFaceWith = (name: string, d: unknown) => window.aiviFace?.setState(name, d);

export const playWav = (b64: string) => window.__aiviMic.play(b64);

export const stopAllVoice = () => window.__aiviMic.stopAll();

/** Start or stop the tap, and silence (or not) the page's own speakers. */
export const setTapOn = (v: boolean, m: boolean) => {
  window.__aiviTap = v;
  if (typeof window.__aiviMute === 'function') window.__aiviMute(m);
};
