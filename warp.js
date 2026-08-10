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
import { readPixels } from "./brow.js";

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// exp(-t) sampled over [0, 4.5]: t = r^2 / 2s^2, and every control is cut off
// at 3 sigma, where t is 4.5. Built once.
const LUT_N = 4096;
const LUT_MAX = 4.5;
const LUT_SCALE = LUT_N / LUT_MAX;
const EXP = new Float32Array(LUT_N + 2);
for (let i = 0; i < EXP.length; i++) EXP[i] = Math.exp(-Math.min(LUT_MAX, i / LUT_SCALE));

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
// Widest points of the face oval, level with the ears.
const EAR_R = 234;
const EAR_L = 454;

export const REQUIRED = [NOSE_TIP, CHIN, HEAD_TOP, MOUTH_L, MOUTH_R, ...EYE_R, ...EYE_L];
const need = REQUIRED;

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

  // Ears pushed out from the head. One further than the other, because ears
  // that stick out evenly just look like ears.
  const earBig = rnd() < 0.5;
  const ears = [[EAR_R, 0.013], [EAR_L, 0.013]].flatMap(([id, base], i) => {
    if (!lm[id]) return [];
    const p = pt(id);
    const dir = outward(p);
    const k = (earBig === (i === 0)) ? 1 : 0.62;
    return [{
      // Centred just outside the face oval so the stretch lands on the ear
      // rather than dragging the cheek with it.
      c: { x: p.x + side.x * dir * 0.035 * H, y: p.y + side.y * dir * 0.035 * H },
      d: move(0, dir * base * k * H, j()),
      s: 0.10 * H,
    }];
  });

  return [
    // eyes: uneven heights, and set a touch too close together
    { c: low, d: move(-0.016 * H, -outward(low) * 0.012 * H, j()), s: 0.11 * H },
    { c: high, d: move(0.006 * H, -outward(high) * 0.012 * H, j()), s: 0.11 * H },
    ...lidPair,
    // nose: longer, leaning, broader at the base
    { c: nose, d: move(-0.024 * H, lean * 0.005 * H, j()), s: 0.10 * H },
    { c: { x: nose.x + side.x * 0.05 * H, y: nose.y + side.y * 0.05 * H }, d: move(0, 0.009 * H, j()), s: 0.07 * H },
    { c: { x: nose.x - side.x * 0.05 * H, y: nose.y - side.y * 0.05 * H }, d: move(0, -0.009 * H, j()), s: 0.07 * H },
    // mouth: dropped away from the nose (long philtrum), narrowed, corners uneven
    { c: mouth, d: move(-0.016 * H, 0, j()), s: 0.10 * H },
    { c: mouthL, d: move(smirk * 0.007 * H, -outward(mouthL) * 0.008 * H, j()), s: 0.06 * H },
    { c: mouthR, d: move(smirk * -0.005 * H, -outward(mouthR) * 0.008 * H, j()), s: 0.06 * H },
    ...ears,
    // Outline controls stay gentle and wide -- a tight pull on the silhouette
    // smears the edge against the background instead of reading as anatomy.
    { c: chin, d: move(-0.008 * H, 0, j()), s: 0.17 * H },
    { c: top, d: move(0.009 * H, 0, j()), s: 0.16 * H },
  ];
}

/**
 * Warp the face in `ctx` in place. Returns the control set that was applied
 * (pass it to `mapLandmarks`), or null if nothing was done.
 * `amount` scales every offset; 1 is the intended subtlety.
 */
export function distortFace(ctx, lm, w, h, amount = 1, seed = 0x5eed1e) {
  if (amount <= 0 || need.some((i) => !lm[i])) return null;
  const cs = controls(lm, w, h, amount, mulberry32(seed));
  if (!cs) return null;

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
  if (bw < 8 || bh < 8) return null;

  const img = readPixels(ctx, x0, y0, bw, bh);
  if (!img) return null;
  const src = new Uint8ClampedArray(img.data);   // untouched copy to sample from
  const out = img.data;

  // Scatter each control into a shared field, visiting only the points inside
  // its own 3-sigma box. The obvious loop -- every pixel against every control
  // -- pays a distance test for all thirteen controls on every pixel in the
  // union of their boxes, and most of those are nowhere near the control.
  //
  // (Evaluating the field on a coarse lattice and interpolating was tried: the
  // field is smooth enough for it, but once the boxes above are in place the
  // cost is dominated by the full-resolution resample below, which a coarser
  // field does not shrink. It bought 1.3x for a page of index arithmetic.)
  const fieldX = new Float32Array(bw * bh);
  const fieldY = new Float32Array(bw * bh);
  let tx0 = bw, ty0 = bh, tx1 = 0, ty1 = 0;   // region the field actually touches

  for (const { c, d, s } of cs) {
    const ccx = c.x - x0, ccy = c.y - y0;
    const reach = s * 3;
    const bx0 = Math.max(0, Math.floor(ccx - reach)), bx1 = Math.min(bw - 1, Math.ceil(ccx + reach));
    const by0 = Math.max(0, Math.floor(ccy - reach)), by1 = Math.min(bh - 1, Math.ceil(ccy + reach));
    if (bx1 < bx0 || by1 < by0) continue;
    if (bx0 < tx0) tx0 = bx0;
    if (by0 < ty0) ty0 = by0;
    if (bx1 > tx1) tx1 = bx1;
    if (by1 > ty1) ty1 = by1;

    const inv = 1 / (2 * s * s);
    const reach2 = reach * reach;
    for (let py = by0; py <= by1; py++) {
      const ey = py - ccy, ey2 = ey * ey;
      const row = py * bw;
      for (let px = bx0; px <= bx1; px++) {
        const ex = px - ccx;
        const r2 = ex * ex + ey2;
        if (r2 > reach2) continue;
        // exp() is the hot instruction here; a table over [0, 4.5] costs at most
        // ~0.1px of displacement error, well inside what the warp cares about.
        const w = EXP[(r2 * inv * LUT_SCALE) | 0];
        fieldX[row + px] += d.x * w;
        fieldY[row + px] += d.y * w;
      }
    }
  }

  for (let py = ty0; py <= ty1; py++) {
    for (let px = tx0; px <= tx1; px++) {
      const idx = py * bw + px;
      const fx = fieldX[idx], fy = fieldY[idx];
      if (fx === 0 && fy === 0) continue;

      // Pull: whatever sat at (p - field) is shown at p.
      const sx = clamp(px - fx, 0, bw - 1.001);
      const sy = clamp(py - fy, 0, bh - 1.001);
      const ix = sx | 0, iy = sy | 0;
      const ftx = sx - ix, fty = sy - iy;
      const a = (iy * bw + ix) * 4, b = a + 4, c = a + bw * 4, d = c + 4;
      const w00 = (1 - ftx) * (1 - fty), w10 = ftx * (1 - fty);
      const w01 = (1 - ftx) * fty, w11 = ftx * fty;
      const o = idx * 4;
      out[o] = src[a] * w00 + src[b] * w10 + src[c] * w01 + src[d] * w11;
      out[o + 1] = src[a + 1] * w00 + src[b + 1] * w10 + src[c + 1] * w01 + src[d + 1] * w11;
      out[o + 2] = src[a + 2] * w00 + src[b + 2] * w10 + src[c + 2] * w01 + src[d + 2] * w11;
    }
  }

  ctx.putImageData(img, x0, y0);
  return cs;
}

/** Displacement of the field at an image-space point. */
export function fieldAt(cs, x, y) {
  let fx = 0, fy = 0;
  for (const { c, d, s } of cs) {
    const ex = x - c.x, ey = y - c.y;
    const r2 = ex * ex + ey * ey;
    if (r2 > (s * 3) ** 2) continue;
    const wgt = Math.exp(-r2 / (2 * s * s));
    fx += d.x * wgt; fy += d.y * wgt;
  }
  return { fx, fy };
}

/**
 * Carry landmarks through the same warp, so the distorted face can be measured
 * without paying for a second inference pass.
 *
 * The warp is defined as dest(p) = src(p - f(p)), so a feature that sat at `q`
 * now appears at the `p` satisfying p = q + f(p). Evaluating f at `q` once is
 * off by roughly |grad f| * |f| -- a few pixels near a control, which is enough
 * to visibly shift a brow. Three fixed-point passes drive that well under a
 * pixel, for a fraction of the cost of running the detector again.
 */
export function mapLandmarks(cs, lm, w, h) {
  if (!cs) return lm;
  return lm.map((p) => {
    if (!p) return p;
    const qx = p.x * w, qy = p.y * h;
    let px = qx, py = qy;
    for (let i = 0; i < 3; i++) {
      const f = fieldAt(cs, px, py);
      px = qx + f.fx;
      py = qy + f.fy;
    }
    return { ...p, x: px / w, y: py / h };
  });
}

/** How far a mapped point misses the exact inverse, in pixels. For tests. */
export function mapResidual(cs, qx, qy, px, py) {
  const f = fieldAt(cs, px, py);
  return Math.hypot(px - f.fx - qx, py - f.fy - qy);
}
