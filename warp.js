// Subtle facial distortion.
//
// The goal is uncanny, not cartoonish: nudges of one to two percent of face
// height, aimed at the proportions people read subconsciously. Asymmetry
// between the eyes, a stretched philtrum and a long chin all register as "off"
// long before anyone can say what was changed. Anything bigger stops being
// unsettling and just looks like a funhouse mirror.
//
// Implemented as a Gaussian displacement field rather than a mesh warp: each
// control point drags its neighbourhood by a fixed offset with a smooth
// falloff, so there are no triangle seams to hide.

import { mulberry32 } from "./rng.js";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Deliberately reliable landmarks only -- face-mesh indices that are stable
// across versions. Everything else is derived geometrically.
const NOSE_TIP = 1;
const CHIN = 152;
const HEAD_TOP = 10;
const MOUTH_L = 61;
const MOUTH_R = 291;
const EYE_R = [33, 133];
const EYE_L = [362, 263];
// Eyelids are optional: used for the uneven-eye-size cue, skipped if absent.
const LID_R = [159, 145];
const LID_L = [386, 374];

const need = [NOSE_TIP, CHIN, HEAD_TOP, MOUTH_L, MOUTH_R, ...EYE_R, ...EYE_L];

function controls(lm, w, h, amount, rnd) {
  // Vary the strength of every cue, and which way the asymmetric ones point, so
  // two photos of the same face are wrong in slightly different ways.
  const j = () => amount * (0.75 + 0.5 * rnd());
  const coin = () => (rnd() < 0.5 ? 1 : -1);

  const pt = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const mid = (ids) => {
    const p = ids.map(pt);
    return { x: p.reduce((a, q) => a + q.x, 0) / p.length, y: p.reduce((a, q) => a + q.y, 0) / p.length };
  };

  const top = pt(HEAD_TOP), chin = pt(CHIN);
  const H = dist(top, chin);
  if (!(H > 40)) return null;

  // Face-local axes, so the distortion survives head roll.
  const up = { x: (top.x - chin.x) / H, y: (top.y - chin.y) / H };
  const side = { x: -up.y, y: up.x };
  const move = (u, s, k = 1) => ({ x: (up.x * u + side.x * s) * k, y: (up.y * u + side.y * s) * k });

  const eyeA = mid(EYE_R), eyeB = mid(EYE_L);
  const face = { x: (top.x + chin.x) / 2, y: (top.y + chin.y) / 2 };
  const outward = (p) => Math.sign((p.x - face.x) * side.x + (p.y - face.y) * side.y) || 1;

  // One eye lower than the other is the single strongest cue, and the one
  // people are least able to name. Which eye drops is a coin flip per shot.
  const [low, high] = rnd() < 0.5 ? [eyeA, eyeB] : [eyeB, eyeA];

  const nose = pt(NOSE_TIP);
  const mouthL = pt(MOUTH_L), mouthR = pt(MOUTH_R);
  const mouth = { x: (mouthL.x + mouthR.x) / 2, y: (mouthL.y + mouthR.y) / 2 };

  // Prising one eye open a little. Interior-only, and mismatched eye size is
  // hard to consciously spot but reliably unsettling.
  const lids = rnd() < 0.5 ? LID_R : LID_L;
  const lidPair = lids.every((i) => lm[i])
    ? (() => {
      const k = j();
      return [
        { c: pt(lids[0]), d: move(0.004 * H, 0, k), s: 0.045 * H },
        { c: pt(lids[1]), d: move(-0.004 * H, 0, k), s: 0.045 * H },
      ];
    })()
    : [];

  const lean = coin();
  const smirk = coin();

  return [
    // eyes: asymmetric height, set slightly too wide
    { c: low, d: move(-0.014 * H, outward(low) * 0.009 * H, j()), s: 0.11 * H },
    { c: high, d: move(0.005 * H, outward(high) * 0.009 * H, j()), s: 0.11 * H },
    ...lidPair,
    // nose: longer, broader at the base
    { c: nose, d: move(-0.020 * H, lean * 0.004 * H, j()), s: 0.10 * H },
    { c: { x: nose.x + side.x * 0.05 * H, y: nose.y + side.y * 0.05 * H }, d: move(0, 0.007 * H, j()), s: 0.07 * H },
    { c: { x: nose.x - side.x * 0.05 * H, y: nose.y - side.y * 0.05 * H }, d: move(0, -0.007 * H, j()), s: 0.07 * H },
    // mouth: dropped away from the nose (long philtrum), corners uneven
    { c: mouth, d: move(-0.013 * H, 0, j()), s: 0.10 * H },
    { c: mouthL, d: move(smirk * 0.006 * H, 0, j()), s: 0.06 * H },
    { c: mouthR, d: move(smirk * -0.004 * H, 0, j()), s: 0.06 * H },
    // chin: a little too long. Kept gentle and wide -- this is the only control
    // touching the face's outline, and a tight pull there smears the jaw edge
    // against the background instead of reading as a longer chin.
    { c: chin, d: move(-0.007 * H, 0, j()), s: 0.17 * H },
  ];
}

/**
 * Warp the face in `ctx` in place. Returns true if anything was applied.
 * `amount` scales every offset; 1 is the intended subtlety.
 */
export function distortFace(ctx, lm, w, h, amount = 1, seed = 0x5eed1e) {
  if (amount <= 0 || need.some((i) => !lm[i])) return false;
  const cs = controls(lm, w, h, amount, mulberry32(seed));
  if (!cs) return false;

  // Only touch the region any control can reach.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { c, d, s } of cs) {
    const r = s * 3 + Math.hypot(d.x, d.y);
    x0 = Math.min(x0, c.x - r); x1 = Math.max(x1, c.x + r);
    y0 = Math.min(y0, c.y - r); y1 = Math.max(y1, c.y + r);
  }
  x0 = clamp(Math.floor(x0), 0, w - 1); y0 = clamp(Math.floor(y0), 0, h - 1);
  x1 = clamp(Math.ceil(x1), 1, w); y1 = clamp(Math.ceil(y1), 1, h);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 8 || bh < 8) return false;

  const img = ctx.getImageData(x0, y0, bw, bh);
  const src = new Uint8ClampedArray(img.data);   // untouched copy to sample from
  const out = img.data;

  // Precompute per-control constants.
  const n = cs.length;
  const cx = new Float64Array(n), cy = new Float64Array(n);
  const dx = new Float64Array(n), dy = new Float64Array(n);
  const k = new Float64Array(n), reach = new Float64Array(n);
  cs.forEach((ctl, i) => {
    cx[i] = ctl.c.x - x0; cy[i] = ctl.c.y - y0;
    dx[i] = ctl.d.x; dy[i] = ctl.d.y;
    k[i] = -1 / (2 * ctl.s * ctl.s);
    reach[i] = (ctl.s * 3) ** 2;
  });

  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      let fx = 0, fy = 0;
      for (let i = 0; i < n; i++) {
        const ex = px - cx[i], ey = py - cy[i];
        const r2 = ex * ex + ey * ey;
        if (r2 > reach[i]) continue;
        const wgt = Math.exp(r2 * k[i]);
        fx += dx[i] * wgt; fy += dy[i] * wgt;
      }

      const o = (py * bw + px) * 4;
      if (fx === 0 && fy === 0) continue;

      // Pull: whatever sat at (p - field) is shown at p.
      const sx = clamp(px - fx, 0, bw - 1.001);
      const sy = clamp(py - fy, 0, bh - 1.001);
      const ix = sx | 0, iy = sy | 0;
      const tx = sx - ix, ty = sy - iy;
      const a = (iy * bw + ix) * 4, b = a + 4, c = a + bw * 4, d = c + 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = src[a + ch] * w00 + src[b + ch] * w10 + src[c + ch] * w01 + src[d + ch] * w11;
      }
    }
  }

  ctx.putImageData(img, x0, y0);
  return true;
}
