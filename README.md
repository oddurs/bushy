# Bushy 🐛

A webcam photobooth that grows you a unibrow — built from *your* hair, not a sticker.

**→ [oddurs.github.io/bushy](https://oddurs.github.io/bushy/)**

Countdown, flash, and a caterpillar creeps out from between your eyes. Everything runs
in the browser; no photo ever leaves your machine.

## The idea

Pasting a cartoon brow on a face is easy and looks it. Bushy never invents hair — it
measures the hair you already have and grows more of the same:

- **Colour** comes from your own brow pixels, then blends partway toward your scalp so
  the result belongs to the head it's sitting on.
- **Thickness** is your measured brow thickness, scaled up.
- **Texture** is estimated from the hair on your head — wavy hair grows a wavy brow.
- **Direction** follows real brow flow: near-vertical over the bridge, sweeping outward
  along the tails.

Then it distorts your face slightly, because a unibrow alone wasn't unsettling enough.

## How it works

**Geometry.** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe) gives 478
landmarks. Both brow contours reduce to a spine plus a per-point thickness, joined across
the bridge with a slight sag. The spine is oriented by projecting onto the axis between
the brows and "up" is derived from eye positions, so the whole thing survives head roll.

**Hair.** ~2,000 individually stroked strands in three passes — a dark bed, the visible
coat, then a few pale flyaways, which is most of what sells it as bushy rather than
painted. Strands are shaded by depth: hair rooted deep sits in the brow's own shadow while
the top layer catches light.

**Texture from a structure tensor.** Waviness is recovered without any model. Straight hair
puts every local image gradient on one axis, so the tensor is strongly anisotropic; waves
and curls scatter the gradients and flatten it. That ratio drives an S-curve amplitude per
strand. Measured on test images: straight hair → 0.26, curly → 0.69.

**Glasses.** Rather than segmenting frames, anything in the brow's neighbourhood that was
already much darker than skin *and* isn't the brow itself gets re-composited on top of the
finished hair. That puts spectacle rims in front — and catches an overhanging fringe and
the lash line too, which should also sit in front of a brow. Colour sampling separately
walks the brow in strips biased above the midline (rims sit at or below the lower edge) and
sanity-checks the result against mid-forehead skin, the one patch that can't be
contaminated. When a rim covers the brow outright, that trips and it borrows your head hair
instead of trusting a black reading.

**Distortion.** A Gaussian displacement field, not a mesh warp, so there are no triangle
seams to hide. Every offset is under 2.5% of face height, aimed at proportions people read
subconsciously rather than at anything they'd consciously notice: eyes set slightly too
close together and at uneven heights, one eye prised a little wider, ears pushed out — one
further than the other, because ears that stick out evenly just look like ears — a longer
leaning nose, a stretched philtrum, a narrowed mouth with uneven corners, a taller
forehead and a slightly long chin.

The controls that touch the face's *outline* (ears, chin, hairline) are deliberately
gentler and much wider than the interior ones. A tight pull on a silhouette smears the
edge against the background instead of reading as anatomy.

**Variation.** One seed per shot drives both the warp and the hair, so no two photos match:
bushiness jitters, strands reshuffle, and the asymmetric cues flip direction. It's seeded
rather than live-random because the reveal repaints every frame, and true randomness would
make the caterpillar shimmer as it grows.

## On a phone

Built for it. The capture reproduces the `object-fit: cover` crop exactly, so the saved
photo is the photo you framed rather than the whole sensor — without that, a portrait phone
saves something quite different from what it showed you. The camera stream is requested in
the screen's orientation, because cropping a landscape stream to a tall frame throws away
most of the pixels and leaves too little face to measure a brow from.

Saving goes through the share sheet where that exists, since an `<a download>` on iOS tends
to just open the image. Front and rear cameras both work (only the front one is mirrored),
the layout respects safe-area insets and `dvh`, and it's installable to the home screen.

## Running it

Any static server over `localhost` (cameras need a secure context):

```sh
python3 -m http.server 7717
```

Then open <http://127.0.0.1:7717>. No build step, no dependencies to install — MediaPipe
loads from a CDN at runtime.

## Knobs

Query parameters, all optional:

| Param | Does |
| --- | --- |
| `?bush=2.1` | Bushiness multiplier (default `1.3`) |
| `?warp=0` | Disable the face distortion (`2.5` exaggerates it) |
| `?seed=123` | Pin a shot so it reproduces exactly |
| `?scalpMix=0.6` | How far the brow colour pulls toward scalp hair (default `0.38`) |

## Layout

| File | |
| --- | --- |
| `app.js` | Camera, countdown, capture, reveal |
| `brow.js` | Measurement and the strand renderer |
| `warp.js` | Facial distortion |
| `rng.js` | Shared seeded PRNG |
| `demo.js` | Dev harness — see below |

`demo.js` paints a synthetic face with known brows, hair and glasses, then runs the real
pipeline over it. It exists because "does this look right?" is otherwise unanswerable
without a webcam and a human. Open `?demo=1` and add `&wavy=1`, `&glasses=1`, `&rim=252`,
`&hair=c9a86a`, or `&p=0.4` to freeze the reveal partway. It's seeded, so renders are
byte-reproducible and comparable across changes. Nothing in the app imports it.

## Notes

[`docs/hardening.md`](docs/hardening.md) — research on the app's failure modes: camera
lifecycle on iOS, canvas memory ceilings, the CDN dependency, and what a test suite should
cover. Survey, not changelog; none of it is implemented yet.

## Licence

MIT
