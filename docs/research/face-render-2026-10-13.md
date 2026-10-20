# How does aivi get a face? (research, 2026-10-13)

Question from the operator: the voice is done; now a visible face — a small,
cute, state-reactive animated avatar (idle/listening/thinking/speaking/waiting)
rendered headlessly on one Apple Silicon box, a few hundred MB and one core,
10–15 fps. First milestone is "selfie mode" (a portrait sent as a chat
message); live video (Meet track) comes later. Research only; nothing built.
Discord video was ruled out already and is not re-researched here.

Sources checked 2026-10-13 (npm, GitHub, vendor license pages, HF model
cards). Anything I could not verify is marked UNVERIFIED.

## 1. Headless rendering of animated 2D/2.5D in Node on macOS

| Library | License | Maturity (2026-10) | Headless verdict |
| --- | --- | --- | --- |
| `@napi-rs/canvas` | MIT | very active (0.1.x → 1.0.x, releases within days; prebuilt `darwin-arm64` for every Node ABI) | **works, zero system deps**; Skia CPU raster; fastest of the three canvas bindings in its own benchmark; `canvas.toBuffer('image/png')`. This is the foundation, not the animation system |
| `skia-canvas` | MIT | active (v3.0.8, Sep 2025; Skia milestone 140; ~131k dl/wk) | works offscreen; adds optional Metal/Vulkan GPU with CPU fallback and even on-screen windows; heavier than napi-rs, no feature we need beyond it |
| `canvas` (node-canvas) | MIT | maintained; prebuilds for macOS aarch64 | works, but Cairo stack and historically more install friction than the two Skia options; skip |
| `gl` (headless-gl) | BSD-2-Clause | alive again — 9.0.0-rc.10 (Apr 2026), prebuilds for Node 20/22/24, Figma/Descript forks exist | WebGL **1.0.3 only** — that single fact kills the three.js route (below) |
| three.js | MIT | active | r163 (Feb 2024) **requires WebGL 2**, so three + headless-gl is dead. `headless-three` (npm, MPL-2.0, 2026) pins three **r162** in a VM sandbox over `gl` + sharp — works but frozen at r162, and VRM skinning shaders on WebGL1 are shaky (their own README flags skinning failing to compile; UNVERIFIED whether their patches fully fix it) |
| PixiJS | MIT | very active (8.20.x) | v7-era `@pixi/node` (pixijs-userland, MIT) renders in Node via `gl`+`canvas` but needs xvfb on Linux and is stale. v8.16 (Feb 2026) shipped an **experimental Canvas 2D renderer** "for environments without a GPU context" — wiring it to `@napi-rs/canvas` through a custom `DOMAdapter` is the clean Node story, but nobody ships that adapter; UNVERIFIED integration effort |
| lottie-web | MIT | 5.13.0 (May 2025), semi-dormant, 5M+ dl/wk | canvas renderer + node-canvas works via `lottie-nodejs` (MIT, UNVERIFIED license file; 4 years old) — usable, ugly plumbing |
| `@lottiefiles/dotlottie-web` | MIT | very active (0.78.0, days ago) | claims isomorphic Node 18+ (wasm/thorvg renderer + Canvas2D); Node path UNVERIFIED in practice |
| Rive | runtime **MIT** (`rive-cpp`, verified LICENSE) | active | headless in Node is real: `breakawaydata/rive-render` (Apache-2.0, Apr 2026) — C++ CLI + TypeScript API, **Rive PLS renderer, Metal on macOS**, PNG/GIF/MP4, state machines + view-model inputs, `screenshot(riv, {stateMachineInputs})`. 5 stars, very young but exactly our use case. Also the official `rive` CLI does `--screenshot=out.png --advance=1s --data=...` with no window and no login (docs/cli/examples) |
| Spine | Spine Runtimes License | active (4.3.x) | **no**: integrating spine-webgl/spine-canvas into a product requires users to hold a paid Spine Editor license; explicitly "may not be sublicensed under MIT". The canvas backend also drops meshes/tinting. Skip |
| sprite-sheet / video-frame playback | — | trivial | pre-decode PNG/WebP/APNG into RGBA buffers once, `drawImage` per tick — a few dozen lines over `@napi-rs/canvas`; for mp4 input, an ffmpeg subprocess. No library needed |

The real finding: **nothing 3D-shaped renders headlessly well in pure Node in
2026** (WebGL2 wall), but 2D/2.5D does, twice over: Skia raster
(`@napi-rs/canvas`) and Rive (Apache-2.0 renderer with a Node API). And the
whole "headless browser" card is already on the table — `@aivi/browser` gives
us a real Chromium that renders anything (see §6).

## 2. VTuber tech drivable by parameters

- **Live2D** — no. Cubism Core (`live2dcubismcore.min.js`) is under the
  **Live2D Proprietary Software License**: closed, redistribution gated,
  publishing derivative works needs the Publication License (individuals and
  <10M JPY businesses exempt, but it is still not an open license — aivi is
  MIT and cannot bundle it). Framework layers are "Live2D Open Software
  License" (source-visible, restricted distribution). `pixi-live2d-display`
  (MIT, 16k dl/wk) is PixiJS **v6**, last published 4 years ago. Parameter
  driving (`ParameterValue` per id) is lovely; the license is not. **Skip.**
- **VRM via `@pixiv/three-vrm`** — the nicest parameter surface anywhere:
  MIT, active (v3, works with three 0.180, © pixiv 2026), and the VRM spec
  bakes in what we want: `expressionManager.setValue('aa', x)` with preset
  expressions `aa / ih / ou / ee / oh` (the five mouth visemes), `blink /
  blinkLeft / blinkRight`, `happy / angry / sad / surprised / relaxed`,
  `lookLeft/Right/Up/Down`, plus `humanoid` bone nodes for head bob and spring
  bones for hair jiggle. **But** it renders through three.js WebGLRenderer →
  needs WebGL2 → headless-gl is out; options are `headless-three` (frozen
  r162, skinning risk) or rendering inside the browser plugin. Keep the **VRM
  expression vocabulary**, defer the renderer.
- **OpenSeeFace / VSeeFace** — misfit: it is a *webcam face tracker*
  (BSD-2-style license, 2k stars), i.e. video→parameters. We have no face and
  no camera; we want audio→parameters. Its UDP protocol is a good design
  reference only. **Skip.**
- **Rive** — the sleeper. A Rive `.riv` is literally "state machine + named
  numeric inputs + vector art" (idle↔listening↔speaking states, a `mouthOpen`
  number, a `blink` trigger — authored by a designer, driven by us), and
  rive-render gives Metal-headless PNG/GIF/MP4 with a TS API. Runtime MIT.
  The renderer wrapper is 5 stars, so treat as promising-but-unproven.
- **2D puppet by hand** — the VU-meter pattern is proven: Automattic's
  `VU-VRM` drives VRM mouth/body from mic volume alone ("volume = movement"),
  `timpratim/visemes-animation` swaps 15 viseme mouth sprites driven by
  wawa-lipsync. RMS→mouth-open over a layered PNG puppet is the boring,
  dependable option. (VU-VRM license: UNVERIFIED, repo has no clear LICENSE.)

## 3. Cute assets with permissive licenses

Verified concrete candidates:

- **Kenney.nl — CC0, all of it** (verified on pack pages): *Shape Characters*
  (100+ sprites, **separate facial features and hands** — practically a
  puppet rig, 533 kB), *Roguelike Characters* (450 files), *Platformer
  Characters*, *Toon Characters*, *Emotes Pack*. CC0 means zero strings for a
  redistributed MIT project. Pixel-cute, not anime-cute.
- **VRoid sample VRMs** (for a future VRM route): `madjin/vrm-samples`
  confirms two tiers — AvatarSample_A/B/C are **not CC0** ("use freely under
  VRoid Hub conditions, copyright not waived", redistribution in apps
  allowed), while alpha-era models (AvatarSample_D/E/F/G, bases, hair
  samples, Sakurada/Sendagaya) were **explicitly released CC0** (mirrored on
  OpenGameArt). VRM itself carries machine-readable license metadata
  (personation, commercial use, redistribution type incl. CC0/CC-BY) that
  `vrm.meta` exposes — the best-behaved avatar format licensing-wise.
- **Live2D sample characters** (Hiyori, Haru, Wankoromochi…): Free Material
  License — free for individuals/small business but per-character rules
  ("Hiyori: no changes of any kind to the design"), mandatory Live2D copyright
  notice, no redistribution of the material itself. Fine for demos, wrong for
  "our mascot".
- **itch.io CC0**: the CC0 filter is real and Kenney mirrors there; beyond
  Kenney I did not verify individual packs (UNVERIFIED: e.g. "Cozy People",
  Pixel Frog packs — licenses vary, check per pack).
- **AI as the asset pipeline**: FLUX.1-schnell is **Apache-2.0 weights** — a
  mascot portrait generated locally on schnell is unencumbered output we own;
  that (plus CC0 bases for the puppet layers) is honestly the licensing
  cleanest path to *our* face. SD1.5 weights are OpenRAIL-M (permissive with
  use restrictions; fine).
- **MJMoonbow/VRMavatars** — small CC0 VRM collection (AI-rigged); existence
  verified, quality UNVERIFIED.

## 4. Audio → mouth

- **wawa-lipsync** (MIT, 211 stars, TS): 15 Oculus/Meta visemes from 7 FFT
  bands + spectral centroid + history smoothing. Read the source: it is
  `window.AudioContext`/`AnalyserNode` only — **browser-only, no offline
  API**. The scoring logic itself is ~300 lines of pure math, portable to
  Node over our in-memory PCM with any FFT. 2.6k dl/wk.
- **Rhubarb Lip Sync** and phoneme-classifiers (espeak/phonemizer pipelines,
  e.g. `XessX/vrm-waifu-lipsync`): real viseme accuracy, extra pipeline
  (Rhubarb: UNVERIFIED license/prebuilds for arm64). Overkill; viseme
  accuracy was ruled optional.
- **DIY RMS (recommended)**: decode TTS wav → RMS per ~80 ms window →
  attack-fast/release-slow smoothing → one `mouthOpen` 0..1. VU-VRM proves
  volume-only movement already reads as "alive". ~30 lines, zero deps, and it
  works the same for 2D mouths, Rive inputs, or VRM `aa` later.
- **Naming decision**: call the parameter set the VRM presets (`aa`-scaled
  mouth open, `blink`, `happy`…) even in the 2D v1, so a future
  three-vrm/Rive renderer is a drop-in.

## 5. Selfie generation on MLX (one-off, seconds–minute OK)

| Option | Weights license | Size / RAM | Notes |
| --- | --- | --- | --- |
| **FLUX.1-schnell** | **Apache-2.0** (verified, BFL license file) | MLX 4-bit: 6.7 GB (illusion615) / 9.2 GB (mzbac, flux.swift); 4 steps | best quality-per-string for a mascot portrait; peak RAM competes with the speech models — run when idle |
| **SD3.5 Medium** | Stability Community License (free < $1M/yr revenue) | 5.11 GB bf16; GGUF q5_0 unet 2.02 GB (calcuis) | needs HF login + license accept; community license is *not* MIT-class |
| **SDXL-Turbo / SD2.1 via mlx-examples `stable_diffusion`** | code MIT; SDXL-Turbo weights OpenRAIL++-M (UNVERIFIED exact variant string) | quantized (TE 4-bit + UNet 8-bit) runs on an 8 GB Mac mini; 2-step turbo | `diffuse-mlx` (PyPI) is a tidy CLI wrapper incl. an SD1.5 DALL-E-style finetune |
| **SD1.5 via `stable-diffusion.cpp`** | code **MIT**; weights OpenRAIL-M | **~1.5–2.0 GB RAM** at 512² with `-M metal --diffusion-fa` (verified doc table); GGUF quants exist; LCM/SD-Turbo supported; active (FLUX.2-klein Jan 2026) | smallest, single binary `sd-cli`, no Python venv; `--vae-tiling`/TAESD |
| API fallback (Replicate/fal/Together) | — | 0 GB local | trivial to add behind the same interface; pricing UNVERIFIED |

Generation times on this box UNVERIFIED (external numbers: schnell 4-step and
SDXL-Turbo 2-step land in seconds-to-tens-of-seconds on M-series; SD1.5 20-step
tens of seconds — UNVERIFIED). Practical note: a few-GB peak for one-off
selfies is acceptable **only serialized against speech jobs** — same pool
discipline as everything else. `mlx-diffuser` (Apache-2.0, Jun 2026) is the
modern MLX diffusers-style lib if we ever embed instead of subprocess.

## 6. Frames → fake webcam / WebRTC (sanity check only)

- **ffmpeg → avfoundation doesn't exist**: avfoundation is capture-only;
  ffmpeg cannot write into a camera device. Dead route, as suspected.
- **OBS Virtual Camera + `pyvirtualcam`** (MIT): OBS 30+ on macOS 13+
  installs a Camera Extension (one-time GUI approval); pyvirtualcam's macOS
  backend sends numpy frames to that device after a one-time OBS start/stop
  ritual — README implies OBS itself then need not run (UNVERIFIED whether it
  truly works closed).
- **Camerarium** (free, Screen Studio team): site unreachable from here
  (transport error ×2) — UNVERIFIED, remembered as "feed a virtual camera
  from a browser tab"; check manually later.
- **The route that actually fits**: Meet presence is already a browser
  (`@aivi/browser`, per the meet-glue doc). Frames never need an OS device —
  draw into a page canvas, `canvas.captureStream(10..15)`,
  `sender.replaceTrack(track)` on the live peer (Baseline everywhere since
  2020; `requestFrame()` even lets us push frames at our own clock). One
  Chromium caveat: old Chrome-headless black-canvas bug reports (crbug
  #40876055, Chrome 107 era) — current `headless=new` UNVERIFIED, must
  bake-test.

## Recommended stack for `@aivi/avatar-simple`

**v1 (selfie + local animated face), all MIT/Apache/CC0:**

- **Compositor**: `@napi-rs/canvas` — MIT, prebuilt arm64, zero system deps,
  tens of MB resident; 512×512 @ 10–15 fps of sprite compositing is nothing
  for it.
- **Avatar**: a hand-rolled **layered 2.5D puppet** — PNG layers (bg, body,
  head, eyes, brows, mouth states) from the avatar's own generated portrait +
  CC0 bases; head bob = canvas transform sine; blink = eyelid layer or eye
  sprite swap on a randomized timer; breathing = slow scale on the body;
  state = which mouth/eye layers show. No renderer dependency at all.
- **Mouth**: DIY RMS from the TTS buffer we already hold (window ~80 ms,
  attack/release smoothing) → `mouthOpen`, mapped to interpolated mouth-shape
  swap; name params after VRM presets (`aa`, `blink`, `happy`) so the
  three-vrm/Rive upgrade path is a rename, not a rewrite.
- **Selfie mode**: `stable-diffusion.cpp` `sd-cli` (MIT) + SD1.5 or
  SDXL-Turbo GGUF (≤2 GB, run idle-time via a job), or FLUX.1-schnell
  (Apache-2.0) when the box is free; API fallback behind the same operation.
  The generated portrait *is* the v1 puppet art — selfie mode bootstraps the
  face.
- **Encoding/streaming**: PNG frames over WebSocket/MJPEG to the local status
  page; ffmpeg subprocess to mp4/webm when a clip is wanted.

**Try next, not v1**: Rive as the authored animation layer (runtime MIT;
`breakawaydata/rive-render` Apache-2.0 Node/Metal renderer — young,
bake-off it); wawa's scoring logic ported to Node if one-mouth-open gets
boring (its MIT, pure math); VRM + three-vrm inside the browser plugin once
the face goes to Meet for real.

**Deferred / rejected**: Live2D (closed core + publication terms), Spine
(paid editor license), headless three.js+VRM via headless-gl (WebGL2 wall —
headless-three's r162 freeze is not a foundation), OpenSeeFace (wrong
direction: webcam→params), OS virtual cameras (OBS/Camerarium — fine for
human demoing, unnecessary once presence is our browser), full viseme
accuracy.

**Verdict**: the face fits the budget with room to spare — Skia raster
compositing at ~1 core and well under the memory ceiling; the only
multi-GB item (selfie generation) is a serialized one-off, which aivi already
knows how to schedule. The two honest risks are both on the 3D side
(WebGL2 in Node, Live2D licensing) and v1 walks straight past them.

**Addendum (operator ruling, 2026-10-13, same day)**: the hand-drawn layered
puppet is OUT — "LLMs are incredibly bad at drawing". The operator proposed
a CRT face (a small TV with simple facial features animated on its screen);
see item 8 of `docs/plans/voice-ship.md`. Everything else here (renderer
choice, licensing verdicts, `captureStream` route, selfie tooling) stands.
