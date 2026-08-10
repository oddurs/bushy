# Making Bushy rock solid

Research notes, August 2026. What actually breaks in a browser camera app, which of it
applies here, and what it would cost to fix. Findings are ranked by how likely they are to
bite a real user, not by how interesting they are.

**All of it is now implemented.** Each finding below carries what was done. The suite in
`tests/` covers the ones that can be tested headlessly — 17 tests, ~9 s, run on every push.

---

## Where it stands

The pipeline is fast and the maths is verified. Measured on the synthetic 900×700 test face:

| Stage | Cost |
| --- | --- |
| `distortFace` | 11–19 ms |
| `buildUnibrow` (measure + generate ~2,000 strands) | 11–20 ms |
| One reveal frame (repaint + strands) | 1–3 ms |
| `landmarker.detect` | not measured on mobile — **the unknown** |

The weaknesses are not in the rendering. They are all in the **lifecycle**: what happens
when the camera goes away, the network is hostile, the device rotates, or the page is
restored from cache. That is the entire gap between "works on my machine" and "rock solid".

---

## Tier 1 — will bite real users

### 1. Camera death is completely unhandled

**The bug.** There is no `ended` listener on the video track, and no `visibilitychange` or
`pagehide` handling anywhere in `app.js`. WebKit deliberately stops capture tracks when a
page is put into the back/forward cache, and
[queues an `ended` event to deliver if the page is ever restored](https://lists.w3.org/Archives/Public/public-webrtc-logs/2023Nov/0019.html).
Safari also ties the media environment to the top frame's URL, so
[a same-document navigation that changes the path kills capture](https://developer.apple.com/forums/thread/750254)
— the video element keeps showing its last frame and the user has to re-enable manually.

**What the user sees.** They background the app, come back, and the preview is a frozen
frame. The shutter is still armed. They tap it, get a countdown, a flash, and a photo of a
stale image — or a black one. Nothing tells them anything is wrong.

**Done.** The track's `ended` event and `visibilitychange` both drop the app into a
`paused` state with a Resume button. `shoot()` also refuses to start if the track isn't
live. Two tests cover it — note that calling `track.stop()` yourself deliberately does *not*
fire `ended` per spec, so the visibility check is what catches the backgrounding case.

### 2. No timeout on the MediaPipe load

**The bug.** `boot()` awaits `loadLandmarker()` with no timeout, no retry, and no
`AbortController`. The spinner says "Warming up…" forever if jsDelivr is slow, blocked by a
corporate proxy, or unreachable.

**Done.** `withTimeout()` races both the camera and the model against 25 s, and any
failure lands in an error state with a working Retry.

### 3. The error state has no way out

`cameraProblem()` wrote decent messages but two of them literally ended in "and reload",
which is asking the user to do the recovery by hand.

**Done.** A single `halt(state, message, label, action)` helper drives every dead end, and
the overlay now carries a button wired to whatever action might fix it. `OverconstrainedError`
got a message too. Asserted by test.

### 4. The CDN is a single point of failure — and unpinned trust

Both the WASM runtime and the 3.58 MB model come from third parties at runtime. If
jsDelivr is down, the app is dead. There is also no integrity check: ES module imports
can't carry SRI hashes without an import map, so a compromised CDN response would execute
with full page privileges.

**Self-hosting is affordable.** Measured from the jsDelivr API:

| Files | Size |
| --- | --- |
| `vision_bundle.mjs` | 0.15 MB |
| SIMD runtime (`vision_wasm_internal.js` + `.wasm`) | 11.52 MB |
| no-SIMD fallback (older devices) | 10.76 MB |
| `face_landmarker.task` model | 3.58 MB |
| **SIMD only** | **≈ 15.3 MB** |
| **with no-SIMD fallback** | **≈ 26.0 MB** |

GitHub Pages allows
[1 GB published site size and 100 GB/month bandwidth](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
so even the full set is under 3% of the size budget. `FilesetResolver.forVisionTasks()`
takes any base path and `modelAssetPath` takes any URL, so this is a config change, not a
code change — **but the files must be published without renaming**.

**One caveat worth respecting:** there are reports that
[MediaPipe task files served from your own server fail on iOS below 16 while working fine from a CDN](https://github.com/google-ai-edge/mediapipe/issues/5767).

**Done.** SIMD runtime and model vendored into `vendor/mediapipe` (15.3 MB) and loaded
first; the CDN stays wired as an automatic fallback, which covers both that iOS caveat and
pre-SIMD devices, since the missing no-SIMD binary 404s straight into the fallback path. A
test asserts the app boots making *no* third-party requests at all.

---

## Tier 2 — correctness under real conditions

### 5. Rotating the device degrades capture quality

`startCamera()` picks portrait or landscape constraints once, from `innerHeight >=
innerWidth` at boot. Rotate afterwards and the stream keeps the old shape, so the cover
crop takes a narrow slice of it — exactly the failure the orientation-aware constraint was
added to prevent. The preview still looks fine, which is what makes it easy to miss.

**Done.** A debounced `resize` listener re-requests the stream, but only when the
orientation class actually flips and only while live.

### 6. iOS canvas memory is a real ceiling

WebKit enforces both a per-canvas area cap of **16,777,216 px** and a **total canvas memory
budget** — [dropped from 448 MB to 224 MB in some versions](https://github.com/WebKit/WebKit/commit/6bd11f3792f05b4e58e5647bf173212879fa62cc),
[384 MB on iOS 15](https://pqina.nl/blog/total-canvas-memory-use-exceeds-the-maximum-limit/).
Two things make this nastier than a normal quota:

- Once the budget is exhausted, **Safari starts drawing transparent canvases** rather than
  throwing. The failure is silent and looks like a rendering bug.
- [`getImageData` can raise `InvalidStateError`](https://github.com/nodeca/pica/issues/231)
  when the canvas has been invalidated.

Bushy is not close to the area cap (1440 px cap → ~1.2 M px per canvas), but it allocates
freely: `buildOccluders` creates **two scratch canvases per face per build** (`brow.js:320`,
`brow.js:339`), and with `numFaces: 5` that is ten, none of them explicitly released.
Safari's accounting is known to lag garbage collection.

**Done.** All six reads go through a shared `readPixels()` that returns null instead of
throwing, and every caller degrades one feature rather than failing the build. Scratch
canvases are zeroed the moment their pixels are copied out, and each brow exposes
`dispose()` for its occluder layer, called whenever brows are replaced or discarded.

### 7. `grabFrame` trusts the video element

`startCamera` waits for `videoWidth` (`app.js:89`) but `grabFrame` reads it unguarded
(`app.js:167`). If the track died between boot and shutter — see finding 1 — `vw`/`vh` are
0, the crop maths produces zeros, and the canvas ends up 1×1.

**Done.** `grabFrame()` returns false on a dead element and the caller drops to paused.

### 8. Two full detections per shot

`shoot()` runs `landmarker.detect()` once before the warp and again after, because
re-measuring the warped photo is easier to reason about than pushing landmarks through the
displacement field. That was the right call for correctness, but it doubles the most
expensive step, and detection is the one cost never measured on a real phone.

**Done — the second pass is gone.** Landmarks are now carried through the same field
analytically. The warp is `dest(p) = src(p - f(p))`, so a feature from `q` appears at the
`p` satisfying `p = q + f(p)`.

Evaluating `f` at `q` once — the obvious approach — is wrong by roughly `|grad f| · |f|`,
which works out to a few pixels near a control: enough to visibly shift a brow. Three
fixed-point passes drive the residual **under 0.01 px**, asserted by test at both normal and
2.5× warp strength, for a few hundred `exp()` calls instead of a whole second inference.

`?redetect=1` restores the old two-pass path for comparison.

---

## Tier 3 — structural

### 9. Automated tests

The largest gap, and the groundwork was already there: `demo.js` paints a synthetic face
from a seeded PRNG and runs the *real* pipeline over it, so results are reproducible.

**Done.** `tests/pipeline.test.mjs` — 17 tests, ~9 s, `node --test`, on every push via
GitHub Actions. It asserts measurements rather than golden images: canvas antialiasing
differs subtly between platforms, and a suite that goes red when you change machine gets
ignored.

| Group | Covers |
| --- | --- |
| measurement | brow colour vs painted truth (dark and light), tone landing between brow and scalp, curly measuring wavier than straight |
| glasses | rim below the brow doesn't darken the reading; frames raise occlusion; a rim *across* the brow is rejected and the fallback clears the plausibility floor |
| warp | forward-map residual sub-pixel at 1× and 2.5×; warp disengages cleanly |
| variation | a seed reproduces exactly; different seeds differ; strand count stays bounded |
| lifecycle | boots with zero third-party requests, denied camera, dead track, externally ended track, phone-viewport crop matches framing |

One wrinkle worth recording: the first version hashed a Playwright element screenshot and
flaked, because under concurrent page load Chromium can switch rasterisation paths and
change antialiasing. Hashing the canvas backing store via `toDataURL()` instead measures
only what we drew, and has been stable across every run since.

### 10. Startup validation of landmark indices

`brow.js` and `warp.js` hardcode mesh indices. The version is pinned, so they will not move
— but a future upgrade would have failed as a subtly misplaced brow rather than a loud
error.

**Done.** Both modules export their `REQUIRED` index list, and the first detection of each
session is checked against the union. A missing index halts with a clear message.

### 11. Offline

**Done by side effect.** With the runtime vendored, the app already touches no network
after the initial page load — verified by the zero-third-party-request test. A service
worker would additionally survive being offline at *first* load; that's the only remaining
increment, and it isn't worth a cache-invalidation story yet.

---

## What is deliberately not worth doing

- **WebGL strand rendering.** Canvas2D paints a frame in 1–3 ms. There is no problem here.
- **Reducing strand counts for speed.** Already bounded by sample count rather than pixel
  spacing, so cost no longer scales with camera resolution.
- **A framework.** Six modules, no build step, and it deploys by pushing to `main`. Nothing
  here is asking for one.

---

## Suggested order

Everything above is done. What is left is the part no headless browser can answer:

- **Real iOS Safari.** The bfcache/`ended` behaviour, the share sheet, `dvh`, and the audio
  unlock are all implemented against documented WebKit behaviour and tested in Chromium.
  They are reasoned, not confirmed on device.
- **A pre-SIMD or iOS-15 device**, to confirm the CDN fallback actually engages rather than
  merely being wired up.
- **`landmarker.detect()` on a mid-range Android.** Still the one unmeasured cost. It now
  runs once per shot instead of twice, so the exposure is halved either way.
