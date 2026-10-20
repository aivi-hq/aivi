/**
 * The face tab: the browser core hands a platform module — camera, mic and
 * ears installed, raw tab on top. The face file (see `face.ts`) is the
 * picture; this file is the media: one injected shim that owns what any
 * meeting page receives when it asks for devices, and what core hears from
 * it, plus the node-side verbs over the same tab.
 *
 * The privacy rule, same shape as the camera: **a page that asks for the
 * operator's camera or microphone never gets it.** Video answers with the
 * face canvas, audio answers with aivi's own voice stream. The real devices
 * stay covered; if the face or the voice never comes up, the ask is
 * refused, not passed through.
 *
 * Hearing works the other direction: everything the page plays out loud
 * (the meeting's remote audio) is tapped in-page — media elements at play,
 * and everything any page AudioContext sends to its speakers — resampled
 * to 16 kHz and delivered through a CDP binding. Proven both directions in
 * headless Chrome 2026-10-13 (tone in, tone out, energy measured).
 *
 * The shared Chrome is lazy and ref-counted: the first face tab launches
 * it (its own profile under the state directory), the last close ends it.
 * No timers, no daemon in between.
 */
import { join } from 'node:path';
import { Chrome, type Tab } from '@aivi/chrome';
import { faceScriptSource, readFaceHtml } from './face.ts';

/** The whole media story, in page words: the camera is the face, the mic
 *  is aivi's voice, and what the page hears flows back to core. Injected
 *  before the page's own scripts run, so the page never meets the real
 *  devices. Plain JS: this text runs in every meeting page. */
export const MEDIA_SHIM = `(() => {
  'use strict';
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const orig = md.getUserMedia.bind(md);
  const frame = () => new Promise(r => requestAnimationFrame(r));

  let ctx = null;
  const ac = () => {
    if (!ctx) ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state !== 'running') ctx.resume();
    return ctx;
  };

  /* ---------- the camera: the face canvas (proven 2026-10-13) ---------- */
  async function faceCanvas() {
    for (let i = 0; i < 600; i++) {
      const c = window.aiviFace && window.aiviFace.canvas;
      if (c) return c;
      await frame();
    }
    return null;
  }

  /* ---------- the mic: aivi's voice, played on one timeline ---------- */
  let micDest = null;
  const mic = () => {
    // a track Meet stops stays stopped: hand out a fresh destination
    // whenever the old one's track has ended (Meet re-acquires devices
    // across the pre-join -> admitted transition, learned 2026-10-14)
    if (micDest && micDest.stream.getAudioTracks()[0]?.readyState !== 'live') micDest = null;
    if (!micDest) {
      micDest = ac().createMediaStreamDestination();
      try { Object.defineProperty(micDest.stream.getAudioTracks()[0], 'label', { value: 'aivi-mic (aivi)' }); } catch {}
    }
    return micDest;
  };
  let cursor = 0;
  const live = new Map();
  window.__aiviMic = {
    async play(wavBase64) {
      const c = ac();
      const bytes = Uint8Array.from(atob(wavBase64), ch => ch.charCodeAt(0));
      const buf = await c.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(mic());
      // answers back to back on one timeline: chunks of one answer must not
      // overlap into garbage, and each wav's promise settles when its last
      // sample has played (the room holds the speaking window open until)
      const startAt = Math.max(c.currentTime + 0.02, cursor);
      src.start(startAt);
      cursor = startAt + buf.duration;
      return new Promise(resolve => {
        live.set(src, resolve);
        src.onended = () => {
          live.delete(src);
          if (live.size === 0) cursor = 0;
          resolve(true);
        };
      });
    },
    stopAll() {
      // barge-in: the playing answer stops NOW and its promise settles
      // false — a window left open is a lie about who is on the air
      for (const [src, resolve] of live) {
        try { src.onended = null; src.stop(); } catch {}
        resolve(false);
      }
      live.clear();
      cursor = 0;
    },
    get playing() { return live.size; },
  };

  /* ---------- the ears: tap what the page plays out loud ---------- */
  window.__aiviTap = false;
  // the page's own speakers, silenced on demand: the tap branches BEFORE
  // the output, and per spec volume does not touch a captured stream —
  // so silencing here keeps aivi hearing everything while the room hears
  // nothing (the operator's room echoed the meeting back at them,
  // 2026-10-14). Elements take volume 0; context-routed audio takes a
  // controllable gain between the page's graph and its real destination.
  let tapMute = false;
  const sinks = [];
  const tapped = new Set();
  window.__aiviMute = (on) => {
    tapMute = !!on;
    const v = tapMute ? 0 : 1;
    try { document.querySelectorAll('video, audio').forEach(el => { el.volume = v; }); } catch {}
    // the ones that matter: Meet plays remote voices through DETACHED
    // "new Audio()" elements — no document, so no querySelectorAll (the
    // operator's room heard the meeting back, 2026-10-14)
    for (const el of tapped) { try { el.volume = v; } catch {} }
    for (const sink of sinks) { try { sink.gain.value = v; } catch {} }
  };
  // an element that hands its audio to the tap also hands over its volume:
  // while tapMute stands, every write to "volume" becomes a write of 0 —
  // Meet sets volume on its elements whenever it likes, and the operator's
  // room being silent is a guarantee, not a wish. (The real internal
  // volume is what the speakers obey, so shadowing the getter alone would
  // be a lie the browser ignores.)
  const volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  const silencePin = (el) => {
    if (el.__aiviVolPinned || !volDesc || !volDesc.get || !volDesc.set) return;
    el.__aiviVolPinned = true;
    Object.defineProperty(el, 'volume', {
      configurable: true,
      get() { return volDesc.get.call(el); },
      set(v) { volDesc.set.call(el, tapMute ? 0 : v); },
    });
    if (tapMute) {
      try {
        volDesc.set.call(el, 0);
      } catch {}
    }
  };
  let tapDest = null;
  let proc = null;
  const tap = () => {
    if (!tapDest) tapDest = ac().createMediaStreamDestination();
    return tapDest;
  };
  const procc = () => {
    if (proc) return proc;
    proc = ac().createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = e => {
      // the processor must stay connected to run; the work is gated here
      if (window.__aiviTap && typeof window.__aiviAudio === 'function') {
        const inp = e.inputBuffer.getChannelData(0);
        const rate = e.inputBuffer.sampleRate;
        const n = Math.floor((inp.length * 16000) / rate);
        const out = new Int16Array(n);
        for (let i = 0; i < n; i++) {
          const pos = (i * rate) / 16000;
          const i0 = Math.floor(pos);
          const frac = pos - i0;
          const v = (inp[i0] || 0) + ((inp[i0 + 1] || 0) - (inp[i0] || 0)) * frac;
          out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        }
        let bin = '';
        const bytes = new Uint8Array(out.buffer);
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        try { window.__aiviAudio(btoa(bin)); } catch {}
      }
      e.outputBuffer.getChannelData(0).fill(0);
    };
    proc.connect(ac().destination);
    return proc;
  };
  const feedTap = (stream) => {
    try {
      if (stream.getAudioTracks().length === 0) return false;
      ac().createMediaStreamSource(stream).connect(procc());
      return true;
    } catch { return false; }
  };
  // route 1: a media element playing out loud (not muted, so not graphed)
  const tapMedia = (el) => {
    if (!(el instanceof HTMLMediaElement) || el.muted || el.__aiviTapped) return;
    try {
      const s = el.captureStream ? el.captureStream() : el.mozCaptureStream();
      if (s && feedTap(s)) {
        el.__aiviTapped = true;
        tapped.add(el);
        silencePin(el); // the room goes quiet now if tapMute stands
      }
    } catch (e) {
      // said, not swallowed: a tap that cannot attach must be findable
      el.__aiviTapError = String(e);
    }
  };
  // attached elements: the play event passes the document on its capture
  // phase (media events do not bubble, capture still reaches us)
  document.addEventListener('play', (e) => tapMedia(e.target), true);
  // detached ones (created with new Audio()/new Video() and never
  // inserted): their events travel only to themselves — no ancestor sees
  // them — so hook play() itself and tap once playback has actually
  // started (by 'playing', the audio tracks exist)
  const playDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play');
  if (playDesc && typeof playDesc.value === 'function') {
    const origPlay = playDesc.value;
    HTMLMediaElement.prototype.play = function () {
      const result = origPlay.apply(this, arguments);
      this.addEventListener('playing', () => tapMedia(this), { once: true });
      return result;
    };
  }
  // route 2: everything any page AudioContext sends to its speakers
  // (a muted, graphed element is silent to route 1 — this catches it)
  const AC = window.AudioContext;
  const realDest =
    Object.getOwnPropertyDescriptor(AC.prototype, 'destination') ||
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(AC.prototype), 'destination');
  if (realDest && realDest.get) {
    Object.defineProperty(AC.prototype, 'destination', {
      configurable: true,
      get() {
        const real = realDest.get.call(this);
        if (this.__aiviOut) return this.__aiviOut;
        const out = this.createGain();
        const sink = this.createGain(); // the page's way to its speakers, under our thumb
        sink.gain.value = tapMute ? 0 : 1;
        out.connect(sink);
        sink.connect(real);
        sinks.push(sink);
        try {
          const cap = this.createGain();
          out.connect(cap);
          if (this === ac()) cap.connect(tap());
          else cap.connect(this.createMediaStreamDestination()); // cross-context: bridge below
        } catch {}
        this.__aiviOut = out;
        return out;
      },
    });
  }

  /* ---------- the ask: video is the face, audio is aivi's voice ---------- */
  md.getUserMedia = async function (constraints) {
    constraints = constraints || {};
    window.__aiviCameraAsked = JSON.parse(JSON.stringify(constraints, (k, v) => (v === undefined ? null : v)) || {});
    if (!constraints.video && !constraints.audio) return orig(constraints);
    const tracks = [];
    if (constraints.video) {
      const canvas = await faceCanvas();
      if (!canvas) throw new DOMException('the aivi face did not come up; the real camera stays covered', 'NotAllowedError');
      // NEVER one cached stream: a stopped track stays ended forever, and
      // Meet stops and asks again across the admitted transition — the
      // cached answer was a dead feed (real meeting, 2026-10-14). Each
      // ask gets its own captureStream of the painting canvas.
      const stream = canvas.captureStream(15);
      const track = stream.getVideoTracks()[0];
      try { Object.defineProperty(track, 'label', { value: 'aivi-face (aivi)' }); } catch {}
      tracks.push(track);
    }
    if (constraints.audio) tracks.push(...mic().stream.getAudioTracks());
    return new MediaStream(tracks);
  };
})();`;

/** The binding name the shim calls with heard audio (base64 s16le 16 kHz
 *  mono), and the CDP event that carries it back to us. */
const AUDIO_BINDING = '__aiviAudio';

/** The whole injection for one meeting page: shim first (it must own the
 *  devices before any page script can ask), then the face's script. */
export async function faceInjection(home: string): Promise<string> {
  return `${MEDIA_SHIM}\n${faceScriptSource(await readFaceHtml(home))}`;
}

/** The shared browser: one launch for the whole host, ref-counted by its
 *  face tabs. The first launch decides the mode (headless or not) — the
 *  browser is shared, so the first face tab's ask is the browser's look. */
let chromePromise: Promise<Chrome> | null = null;
let chromeUsers = 0;
async function sharedChrome(stateDir: string, headless: boolean): Promise<Chrome> {
  chromePromise ??= Chrome.launch({ profileDir: join(stateDir, 'face-chrome'), headless });
  chromeUsers++;
  return chromePromise;
}
async function releaseChrome(): Promise<void> {
  chromeUsers--;
  if (chromeUsers === 0 && chromePromise !== null) {
    const promise = chromePromise;
    chromePromise = null;
    await (await promise).close();
  }
}

export interface FaceTabOptions {
  /** The aivi home: where `<home>/face/index.html` is read from. */
  home: string;
  /** The state directory (`config.stateDirectory`): where the browser's
   *  own profile lives. */
  stateDir: string;
  /** Where to take the face. */
  url: string;
  /** Install the ears: the binding goes in before navigation, so no heard
   *  sample is lost. Default false: a face-only tab. */
  hear?: boolean;
  /** Default true. False opens a real window — the honest mode for
   *  conferencing pages: the user agent, client hints and screen are the
   *  browser's own (nothing to override, nothing to fake), and a human
   *  can watch the meeting happen. Ruled 2026-10-14 after Meet refused
   *  the headless look. */
  headless?: boolean;
  /** How long the page gets to load and paint the face. Default 20000. */
  readyTimeoutMs?: number;
}

/** A face tab: the raw tab (every protocol verb on it — that is the point)
 *  plus the media verbs and the close that balances the shared browser's
 *  count. */
export interface FaceTab {
  tab: Tab;
  /** Did the page ask for devices yet (proof the shim answered)? Info,
   *  never a gate: some pages ask pre-join, some only after. */
  cameraAsked(): Promise<unknown>;
  /** Say the face's state (`idle`, `listening`, …). */
  setFaceState(state: string, detail?: Record<string, unknown>): Promise<void>;
  /** Play one wav as aivi's voice; the promise settles when the last
   *  sample has played, or false when a stop cut it. Back-to-back calls
   *  queue on one timeline — they never overlap. */
  speak(wav: Buffer): Promise<boolean>;
  /** Silence the voice NOW (barge-in): every playing and queued wav is
   *  cut and its promise settles false. */
  stopSpeaking(): Promise<void>;
  /** Start or stop hearing the page's outgoing-audio tap. `muteOutput`
   *  (default true) also silences the page's OWN speakers — aivi hears
   *  the meeting, the room does not (captured audio is taken before the
   *  volume control; the operator's room must not become the meeting's
   *  speaker). Pass false only when a human wants to monitor out loud. */
  setTap(on: boolean, muteOutput?: boolean): Promise<void>;
  /** Heard audio as it arrives: s16le 16 kHz mono chunks. Returns the
   *  unsubscribe. */
  onAudio(listener: (pcm: Buffer) => void): () => void;
  /** Notice the shared browser dying on its own — a crash, or a hand at
   *  the Activity Monitor. The meeting owner uses it to clear its state:
   *  a dead browser must leave no phantom call, and no mouth may keep
   *  knocking on a closed connection. */
  onGone(listener: () => void): () => void;
  /** Close the tab; when it was the last face tab, end the browser too. */
  close(): Promise<void>;
}

/** Open a tab wearing the face: launch-or-reuse the shared Chrome, install
 *  the media shim + face before the page's scripts run, look like a normal
 *  Chrome, navigate, and resolve only when the face is live and painting.
 *  Not joined, not admitted — no platform's buttons are anybody's business
 *  but the platform's. */
export async function openFaceTab(options: FaceTabOptions): Promise<FaceTab> {
  const injection = await faceInjection(options.home); // fail before the browser moves
  const chrome = await sharedChrome(options.stateDir, options.headless ?? true);
  let tab: Tab | undefined;
  const audioListeners = new Set<(pcm: Buffer) => void>();
  const goneListeners = new Set<() => void>();
  chrome.onGone(() => {
    for (const listener of [...goneListeners]) listener();
  });
  try {
    tab = await chrome.newTab();
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: injection });
    if (options.hear) {
      // the binding must exist before the page's first breath, so it goes
      // in before navigation
      await tab.send('Runtime.enable');
      await tab.send('Runtime.addBinding', { name: AUDIO_BINDING });
      tab.on('Runtime.bindingCalled', event => {
        if (event.params?.name !== AUDIO_BINDING || typeof event.params.payload !== 'string') return;
        const pcm = Buffer.from(event.params.payload, 'base64');
        for (const listener of audioListeners) listener(pcm);
      });
    }
    // the UA is cleaned BEFORE navigation: the page should never see
    // "Headless" in the first place, not have it patched after load
    await tab.hideHeadless();
    await tab.goto(options.url, { timeoutMs: options.readyTimeoutMs ?? 20_000 });
    await tab.waitFor(() => typeof (window as any).aiviFace === 'object', {
      timeoutMs: options.readyTimeoutMs ?? 20_000,
    });
  } catch (error) {
    if (tab !== undefined) await tab.close().catch(() => {});
    await releaseChrome().catch(() => {});
    throw error;
  }
  let closed = false;
  const setFaceState = async (state: string, detail?: Record<string, unknown>): Promise<void> => {
    if (detail === undefined) await tab!.call((name: string) => (window as any).aiviFace?.setState(name), state);
    else await tab!.call((name: string, d: unknown) => (window as any).aiviFace?.setState(name, d), state, detail);
  };
  return {
    tab,
    cameraAsked: () => tab!.evaluate('window.__aiviCameraAsked'),
    setFaceState,
    speak: wav => tab!.call((b64: string) => (window as any).__aiviMic.play(b64), wav.toString('base64')),
    stopSpeaking: async () => {
      await tab!.call(() => (window as any).__aiviMic.stopAll());
    },
    setTap: async (on, muteOutput = true) => {
      await tab!.call(
        (v: boolean, m: boolean) => {
          (window as any).__aiviTap = v;
          if (typeof (window as any).__aiviMute === 'function') (window as any).__aiviMute(m);
        },
        on,
        muteOutput,
      );
    },
    onAudio: listener => {
      audioListeners.add(listener);
      return () => {
        audioListeners.delete(listener);
      };
    },
    onGone: listener => {
      goneListeners.add(listener);
      return () => {
        goneListeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await tab!.close();
      await releaseChrome();
    },
  };
}
