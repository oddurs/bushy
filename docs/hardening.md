# Making Bushy rock solid

Research notes, August 2026. What actually breaks in a browser camera app, which of it
applies here, and what it would cost to fix. Findings are ranked by how likely they are to
bite a real user, not by how interesting they are.

Nothing here is implemented yet — this is the survey.

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

**Fix.** Listen for `ended` on the track and for `visibilitychange`. On either, drop to a
distinct `paused` state with a "Camera stopped — tap to resume" affordance that re-runs
`startCamera()`. Cheap, and it removes the single worst failure in the app.

### 2. No timeout on the MediaPipe load

**The bug.** `boot()` awaits `loadLandmarker()` with no timeout, no retry, and no
`AbortController`. The spinner says "Warming up…" forever if jsDelivr is slow, blocked by a
corporate proxy, or unreachable.

**Fix.** `Promise.race` the load against a ~20 s timeout, then show a real error with a
Retry button. Ten lines.

### 3. The error state has no way out

`cameraProblem()` writes decent messages but two of them literally end in "and reload",
which is asking the user to do the recovery by hand. There is no retry button anywhere in
the markup. Every terminal state should offer the action that might fix it.

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
If self-hosting, keep the CDN as a fallback rather than deleting it, and verify on an old
device before switching the default.

---

## Tier 2 — correctness under real conditions

### 5. Rotating the device degrades capture quality

`startCamera()` picks portrait or landscape constraints once, from `innerHeight >=
innerWidth` at boot. Rotate afterwards and the stream keeps the old shape, so the cover
crop takes a narrow slice of it — exactly the failure the orientation-aware constraint was
added to prevent. The preview still looks fine, which is what makes it easy to miss.

**Fix.** Re-request the stream on `orientationchange`, debounced, and only when the
orientation class actually flips.

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

**Fix.** Set `canvas.width = canvas.height = 0` on scratch canvases once their pixels have
been read — the documented way to return the memory immediately. Wrap every `getImageData`
in a try/catch that degrades to "no occluders" rather than failing the whole build. There
are six `getImageData` calls across `brow.js` and `warp.js`; none is currently guarded.

### 7. `grabFrame` trusts the video element

`startCamera` waits for `videoWidth` (`app.js:89`) but `grabFrame` reads it unguarded
(`app.js:167`). If the track died between boot and shutter — see finding 1 — `vw`/`vh` are
0, the crop maths produces zeros, and the canvas ends up 1×1. Guard it and fail into the
paused state.

### 8. Two full detections per shot

`shoot()` runs `landmarker.detect()` once before the warp and again after, because
re-measuring the warped photo is easier to reason about than pushing landmarks through the
displacement field. That was the right call for correctness, but it doubles the most
expensive step, and detection is the one cost never measured on a real phone.

**Before optimising, measure it.** If detection turns out to be 200 ms+ on a mid-range
Android, the fix is to map the landmarks forward through the field analytically — the field
is `dest(p) = src(p - f(p))`, so a landmark at `p` lands near `p + f(p)`, which is one
Gaussian evaluation per landmark instead of a whole second inference. If detection is 40 ms,
leave it alone.

---

## Tier 3 — structural

### 9. There are no automated tests

This is the largest single gap, and the groundwork is already done. `demo.js` paints a
synthetic face from a seeded PRNG and runs the *real* pipeline over it, so renders are
byte-reproducible — verified earlier by hashing the same seed twice.

That is a regression suite waiting to be written:

- **Metric assertions** on `window.__demo`, which already exposes everything needed:
  sampled colour within tolerance of the painted colour; `waviness` strictly higher for
  `&wavy=1` than the straight case; `suspect` true for `&rim=252` and false otherwise;
  `occluded` materially higher with `&glasses=1` than without.
- **Golden images** — hash the `#shot` canvas across a fixed matrix of seeds and flags,
  fail on drift, and write the new images to an artifact directory for eyeballing.
- **Lifecycle tests** with Playwright's fake camera: permission denied, no device, and
  (once implemented) track-ended recovery.

All of it runs headless in CI on the fixed seeds. No device farm needed for the maths —
only for the iOS quirks in Tier 1.

### 10. No startup validation of landmark indices

`brow.js` and `warp.js` hardcode mesh indices (`70`, `107`, `159`, `234`…). The version is
pinned, so they will not move — but a future upgrade would fail as a subtly misplaced brow
rather than a loud error. A one-line assertion at boot that the required indices exist in
the first detection would turn a silent visual bug into a clear one.

### 11. Offline

Everything after load is local — no network is touched during a shot. If the runtime is
self-hosted (finding 4), a service worker caching the shell plus the WASM and model would
make the app fully offline and eliminate cold-start latency on repeat visits. Not worth the
complexity while the CDN is a runtime dependency, since that's the part that would still
fail.

---

## What is deliberately not worth doing

- **WebGL strand rendering.** Canvas2D paints a frame in 1–3 ms. There is no problem here.
- **Reducing strand counts for speed.** Already bounded by sample count rather than pixel
  spacing, so cost no longer scales with camera resolution.
- **A framework.** Six modules, no build step, and it deploys by pushing to `main`. Nothing
  here is asking for one.

---

## Suggested order

1. Track-`ended` / visibility recovery, plus a `paused` state (finding 1, 7)
2. Load timeout and a Retry button on every terminal state (2, 3)
3. Guard every `getImageData`; release scratch canvases (6)
4. Re-request the stream on orientation change (5)
5. Playwright metric + golden-image suite in CI (9)
6. Measure `detect()` on a real phone, then decide about the second pass (8)
7. Self-host the runtime with the CDN as fallback (4)

Items 1–4 are each well under an hour and cover every failure a user is realistically going
to hit. Item 5 is what stops the rest from regressing.
