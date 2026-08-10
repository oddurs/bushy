// Unibrow construction.
//
// The whole trick: never invent hair. Measure the brows the person already has
// -- their pixel colour, their thickness, the direction they grow -- and the
// hair on their head -- its colour and how wavy it is -- then build one
// continuous caterpillar along the same ridge, at the same aesthetic, only
// vastly more of it.

import { mulberry32 } from "./rng.js";

// MediaPipe face-mesh contours. Each pair is ordered outer -> inner.
const BROW_R = {
  upper: [70, 63, 105, 66, 107],
  lower: [46, 53, 52, 65, 55],
};
const BROW_L = {
  upper: [300, 293, 334, 296, 336],
  lower: [276, 283, 282, 295, 285],
};
// Eye corners, used only to work out which way is "up" on the face.
const EYE_REF = [33, 133, 362, 263];
const HEAD_TOP = 10;
const CHIN = 152;

const FALLBACK = { rgb: [58, 42, 34], spread: 0.22 };

// Every mesh index this module depends on. Validated once against a real
// detection at boot, so a future model change fails loudly instead of quietly
// putting the brow in the wrong place.
export const REQUIRED = [
  ...BROW_R.upper, ...BROW_R.lower, ...BROW_L.upper, ...BROW_L.lower,
  ...EYE_REF, HEAD_TOP, CHIN, 9,
];

// ---------------------------------------------------------------- vectors

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const rot = (v, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
};

function centroid(pts) {
  const m = pts.reduce((acc, p) => add(acc, p), { x: 0, y: 0 });
  return { x: m.x / pts.length, y: m.y / pts.length };
}

const scratch = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
};

// Zeroing the dimensions hands the pixels back immediately. WebKit's canvas
// memory accounting lags garbage collection, and once its budget is exhausted
// it silently starts drawing *transparent* canvases rather than throwing.
export const release = (c) => { if (c) { c.width = 0; c.height = 0; } };

// getImageData throws InvalidStateError on a canvas Safari has invalidated.
// Every read here is best-effort: a null result degrades one feature rather
// than failing the whole build.
export function readPixels(ctx, x, y, w, h) {
  try {
    return ctx.getImageData(x, y, w, h);
  } catch {
    return null;
  }
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;


// ---------------------------------------------------------------- geometry

// A brow reduces to a spine (midline), a thickness, and a local "up" running
// from the lower contour to the upper one.
function browSpine(lm, brow, w, h) {
  const pt = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  return brow.upper.map((ui, k) => {
    const u = pt(ui), l = pt(brow.lower[k]);
    const d = sub(u, l);
    return { x: (u.x + l.x) / 2, y: (u.y + l.y) / 2, t: len(d), up: norm(d) };
  });
}

// Order a brow's samples from its outer end to its inner end, by projecting
// onto the axis between the two brows. Survives head roll, and survives the
// mesh index order changing under us.
function orientOutwardIn(spine, otherCentroid) {
  const axis = norm(sub(otherCentroid, centroid(spine)));
  return [...spine].sort((a, b) => dot(a, axis) - dot(b, axis));
}

function resample(spine, spacing) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i], b = spine[i + 1];
    const d = len(sub(b, a));
    if (d < 1e-6) continue;
    for (let s = carry; s < d; s += spacing) {
      const f = s / d;
      out.push({ x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), t: lerp(a.t, b.t, f) });
    }
    carry = (spacing - ((d - carry) % spacing)) % spacing;
  }
  out.push({ x: spine[spine.length - 1].x, y: spine[spine.length - 1].y, t: spine[spine.length - 1].t });
  return out;
}

function smooth(spine, passes) {
  let cur = spine;
  for (let p = 0; p < passes; p++) {
    cur = cur.map((pt, i) => {
      const a = cur[Math.max(0, i - 1)], b = cur[Math.min(cur.length - 1, i + 1)];
      return { x: (a.x + pt.x * 2 + b.x) / 4, y: (a.y + pt.y * 2 + b.y) / 4, t: (a.t + pt.t * 2 + b.t) / 4 };
    });
  }
  return cur;
}

// Thickness envelope across the finished unibrow: full through the brow
// bodies, tapering at the outer tails, and slightly *lighter* over the bridge.
// Real unibrows are sparser where they join -- peaking in the middle is what
// turns the whole thing into a headdress.
function envelope(u) {
  const d = Math.abs(u - 0.5) * 2;
  let p = 1;
  if (d > 0.62) {
    const k = (d - 0.62) / 0.38;
    p = 1 - 0.55 * k * k;
  }
  p *= 1 - 0.12 * Math.exp(-((d / 0.28) ** 2));
  return p;
}

// ---------------------------------------------------------------- colour

const median = (rows, k) => {
  const s = rows.map((c) => c[k]).sort((a, b) => a - b);
  return s[s.length >> 1];
};

const mixRgb = (a, b, f) => a.map((v, i) => Math.round(lerp(v, b[i], f)));

// Read the person's real brow colour off the photo.
function sampleHair(ctx, spines, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of spines) {
    for (const p of sp) {
      x0 = Math.min(x0, p.x - p.t); x1 = Math.max(x1, p.x + p.t);
      y0 = Math.min(y0, p.y - p.t); y1 = Math.max(y1, p.y + p.t);
    }
  }
  x0 = clamp(Math.floor(x0), 0, w - 1); y0 = clamp(Math.floor(y0), 0, h - 1);
  x1 = clamp(Math.ceil(x1), 1, w); y1 = clamp(Math.ceil(y1), 1, h);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 2 || bh < 2) return FALLBACK;

  const px0 = readPixels(ctx, x0, y0, bw, bh);
  if (!px0) return FALLBACK;
  const img = px0.data;
  const hits = [];
  const at = (x, y) => {
    const px = Math.round(x) - x0, py = Math.round(y) - y0;
    if (px < 0 || py < 0 || px >= bw || py >= bh) return;
    const o = (py * bw + px) * 4;
    const R = img[o], G = img[o + 1], B = img[o + 2];
    hits.push([R, G, B, luma(R, G, B)]);
  };

  // Walk the brow as strips along its own "up", biased above the midline:
  // spectacle rims and the lash line sit at or below the brow's lower edge, so
  // only the top of the band is reliably hair.
  for (const sp of spines) {
    for (let i = 0; i < sp.length - 1; i++) {
      const a = sp[i], b = sp[i + 1];
      for (let k = 0; k < 10; k++) {
        const f = k / 10;
        const x = lerp(a.x, b.x, f), y = lerp(a.y, b.y, f), t = lerp(a.t, b.t, f);
        const ux = lerp(a.up.x, b.up.x, f), uy = lerp(a.up.y, b.up.y, f);
        for (let s = -0.08 * t; s <= 0.46 * t; s += 1) at(x + ux * s, y + uy * s);
      }
    }
  }
  if (hits.length < 40) return FALLBACK;

  // Skip the very darkest pixels -- brow-ridge shadow and lash line -- then
  // take a per-channel median, which a stray dark frame barely moves.
  hits.sort((a, b) => a[3] - b[3]);
  const lo = Math.floor(hits.length * 0.14);
  const take = hits.slice(lo, Math.max(lo + 24, Math.floor(hits.length * 0.55)));

  const lum = take.reduce((a, c) => a + c[3], 0) / take.length;
  const varr = take.reduce((a, c) => a + (c[3] - lum) ** 2, 0) / take.length;
  const spread = clamp(Math.sqrt(varr) / Math.max(lum, 12), 0.1, 0.42);

  return {
    rgb: [median(take, 0), median(take, 1), median(take, 2)].map((v) => clamp(Math.round(v), 6, 235)),
    spread,
  };
}

// Median forehead luminance. Mid-forehead is the one patch guaranteed to be
// plain skin, which makes it the reference for deciding whether a brow reading
// is physically plausible.
function sampleSkin(ctx, lm, w, h) {
  if (!lm[9] || !lm[HEAD_TOP]) return 0;
  const a = { x: lm[9].x * w, y: lm[9].y * h };
  const b = { x: lm[HEAD_TOP].x * w, y: lm[HEAD_TOP].y * h };
  const c = { x: lerp(a.x, b.x, 0.5), y: lerp(a.y, b.y, 0.5) };
  const r = Math.max(4, len(sub(b, a)) * 0.2);
  const x0 = clamp(Math.floor(c.x - r), 0, w - 1), y0 = clamp(Math.floor(c.y - r), 0, h - 1);
  const x1 = clamp(Math.ceil(c.x + r), 1, w), y1 = clamp(Math.ceil(c.y + r), 1, h);
  if (x1 - x0 < 3 || y1 - y0 < 3) return 0;
  const px = readPixels(ctx, x0, y0, x1 - x0, y1 - y0);
  if (!px) return 0;
  const d = px.data;
  const ls = [];
  for (let i = 0; i < d.length; i += 4) ls.push(luma(d[i], d[i + 1], d[i + 2]));
  ls.sort((p, q) => p - q);
  return ls[ls.length >> 1];
}

// Read the hair on the head: its colour, and how wavy it is.
//
// Waviness comes from a structure tensor. Straight hair puts every local
// gradient along the same axis, so the tensor is strongly anisotropic; waves
// and curls scatter the gradients and flatten it out. That ratio is a usable
// curliness estimate without any model.
function analyseScalp(ctx, lm, w, h) {
  if (!lm[HEAD_TOP] || !lm[CHIN]) return null;
  const pt = (i) => ({ x: lm[i].x * w, y: lm[i].y * h });
  const top = pt(HEAD_TOP), chin = pt(CHIN);
  const faceH = len(sub(top, chin));
  if (faceH < 60) return null;

  const up = norm(sub(top, chin));
  const side = { x: -up.y, y: up.x };
  const halfW = faceH * 0.17, d0 = faceH * 0.04, d1 = faceH * 0.26;

  const corners = [];
  for (const fu of [d0, d1]) {
    for (const fs of [-halfW, halfW]) {
      corners.push({ x: top.x + up.x * fu + side.x * fs, y: top.y + up.y * fu + side.y * fs });
    }
  }
  let x0 = clamp(Math.floor(Math.min(...corners.map((c) => c.x))), 0, w - 1);
  let y0 = clamp(Math.floor(Math.min(...corners.map((c) => c.y))), 0, h - 1);
  const x1 = clamp(Math.ceil(Math.max(...corners.map((c) => c.x))), 1, w);
  const y1 = clamp(Math.ceil(Math.max(...corners.map((c) => c.y))), 1, h);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 10 || bh < 10) return null;

  const scalpPx = readPixels(ctx, x0, y0, bw, bh);
  if (!scalpPx) return null;
  const img = scalpPx.data;

  // Work at full pixel resolution. Sampling this onto a coarse grid aliases
  // individual strands into noise, and noise has no dominant orientation, so
  // every head measures as curly.
  // Histograms rather than an array of per-pixel tuples: this loop runs over
  // every pixel of the patch, and allocating there dominated the whole build.
  // Medians come out of the bins in one pass instead of three sorts.
  const lums = new Float32Array(bw * bh).fill(-1);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0, sumL = 0, sumL2 = 0;
  // Walk the patch in its own axes: rel = (px,py) - top, projected onto up/side.
  const relX0 = x0 - top.x, relY0 = y0 - top.y;
  for (let py = 0; py < bh; py++) {
    const ry = py + relY0;
    for (let px = 0; px < bw; px++) {
      const rx = px + relX0;
      const fu = rx * up.x + ry * up.y;
      if (fu < d0 || fu > d1) continue;
      const fs = rx * side.x + ry * side.y;
      if (fs < -halfW || fs > halfW) continue;
      const o = (py * bw + px) * 4;
      const R = img[o], G = img[o + 1], B = img[o + 2];
      const L = luma(R, G, B);
      lums[py * bw + px] = L;
      hist[0][R]++; hist[1][G]++; hist[2][B]++;
      n++; sumL += L; sumL2 += L * L;
    }
  }
  if (n < 900) return null;

  const mean = sumL / n;
  const sd = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
  const histMedian = (h) => {
    let c = 0;
    for (let i = 0; i < 256; i++) { c += h[i]; if (c * 2 > n) return i; }
    return 255;
  };

  const at = (r, c) => (r < 0 || c < 0 || r >= bh || c >= bw ? -1 : lums[r * bw + c]);
  const grad = (r, c, dr, dc) => {
    const a = at(r + dr, c + dc), b = at(r - dr, c - dc);
    return a < 0 || b < 0 ? null : (a - b) / 2;
  };

  const WIN = 8;
  let cohSum = 0, cohN = 0;
  for (let r0 = 1; r0 + WIN < bh - 1; r0 += WIN) {
    for (let c0 = 1; c0 + WIN < bw - 1; c0 += WIN) {
      let Jxx = 0, Jyy = 0, Jxy = 0, ok = 0;
      for (let r = r0; r < r0 + WIN; r++) {
        for (let c = c0; c < c0 + WIN; c++) {
          const a = grad(r, c, 0, 1), b = grad(r, c, 1, 0);
          if (a === null || b === null) continue;
          Jxx += a * a; Jyy += b * b; Jxy += a * b;
          ok++;
        }
      }
      const tr = Jxx + Jyy;
      if (ok < WIN * WIN * 0.7 || tr < 4) continue;
      cohSum += Math.sqrt((Jxx - Jyy) ** 2 + 4 * Jxy * Jxy) / tr;
      cohN++;
    }
  }
  const coherence = cohN ? cohSum / cohN : 0.55;

  return {
    // Flat, low-texture patches are forehead, a wall or a bald head -- not hair
    // worth copying.
    hairLike: sd > 9 && cohN > 3,
    rgb: hist.map((h) => clamp(histMedian(h), 6, 240)),
    waviness: clamp((1 - coherence) * 1.25, 0, 1),
    coherence,
    texture: sd,
  };
}

const shade = (rgb, f, a) =>
  `rgba(${clamp(Math.round(rgb[0] * f), 0, 255)},${clamp(Math.round(rgb[1] * f), 0, 255)},${clamp(Math.round(rgb[2] * f), 0, 255)},${a})`;

// ---------------------------------------------------------------- occlusion

// Anything in the brow's neighbourhood that was already much darker than skin,
// and isn't the brow itself, gets lifted back over the finished hair. That is
// spectacle frames most of the time, but it also catches an overhanging fringe
// and the lash line -- all things that should sit in front of a brow, not
// behind it. Cheaper and far more robust than trying to segment glasses.
function buildOccluders(srcCtx, spine, w, h) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of spine) {
    x0 = Math.min(x0, p.x - p.t); x1 = Math.max(x1, p.x + p.t);
    y0 = Math.min(y0, p.y - p.t); y1 = Math.max(y1, p.y + p.t);
  }
  x0 = clamp(Math.floor(x0) - 4, 0, w - 1); y0 = clamp(Math.floor(y0) - 4, 0, h - 1);
  x1 = clamp(Math.ceil(x1) + 4, 1, w); y1 = clamp(Math.ceil(y1) + 4, 1, h);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 8 || bh < 8) return null;

  // Mask of the person's own brow, so we never paint their old brow back on
  // top of the new one.
  const mask = scratch(bw, bh);
  const mctx = mask.getContext("2d", { willReadFrequently: true });
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, bw, bh);
  mctx.fillStyle = "#fff";
  mctx.beginPath();
  spine.forEach((p, i) => {
    const q = add(p, mul(p.up, p.t0 * 0.72));
    i ? mctx.lineTo(q.x - x0, q.y - y0) : mctx.moveTo(q.x - x0, q.y - y0);
  });
  for (let i = spine.length - 1; i >= 0; i--) {
    const p = spine[i];
    const q = add(p, mul(p.up, -p.t0 * 0.72));
    mctx.lineTo(q.x - x0, q.y - y0);
  }
  mctx.closePath();
  mctx.fill();
  const maskPx = readPixels(mctx, 0, 0, bw, bh);
  release(mask);            // pixels are copied out; give the memory straight back
  if (!maskPx) return null;
  const md = maskPx.data;

  const layer = scratch(bw, bh);
  const lctx = layer.getContext("2d", { willReadFrequently: true });
  lctx.drawImage(srcCtx.canvas, x0, y0, bw, bh, 0, 0, bw, bh);
  const id = readPixels(lctx, 0, 0, bw, bh);
  if (!id) { release(layer); return null; }
  const d = id.data;

  // Skin baseline from the bright end of the neighbourhood, so the threshold
  // scales with exposure and skin tone instead of being a fixed grey. Histogram
  // percentile: sorting every pixel of the region to read one quantile was the
  // second most expensive thing in the build.
  const lumHist = new Uint32Array(256);
  const total = d.length >> 2;
  for (let i = 0; i < d.length; i += 4) lumHist[luma(d[i], d[i + 1], d[i + 2]) | 0]++;
  let base = 255;
  for (let i = 0, seen = 0; i < 256; i++) {
    seen += lumHist[i];
    if (seen >= total * 0.72) { base = i; break; }
  }
  if (base < 24) { release(layer); return null; }

  let kept = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const L = luma(d[i], d[i + 1], d[i + 2]);
    const a = md[i] > 128 ? 0 : clamp((base * 0.7 - L) / (base * 0.16), 0, 1);
    d[i + 3] = Math.round(a * 255);
    if (a > 0.5) kept++;
  }
  // A handful of stray dark pixels is noise, not a pair of glasses.
  if (kept < bw * bh * 0.012) { release(layer); return null; }

  lctx.putImageData(id, 0, 0);
  return { canvas: layer, x: x0, y: y0, coverage: kept / (bw * bh) };
}

// ---------------------------------------------------------------- strands

function growStrands(spine, tone, waviness, rnd, opts) {
  const strands = [];
  const n = spine.length;

  // Low-frequency wobble in strand length. Without it the silhouette comes out
  // as an even hedge; the lumps are what make it read as a caterpillar.
  const ph = [rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2];
  const lump = (u) =>
    1 + 0.15 * Math.sin(u * 13 + ph[0]) + 0.09 * Math.sin(u * 29 + ph[1]) + 0.06 * Math.sin(u * 51 + ph[2]);

  const emit = (layer, countScale, lenScale, widthScale, shadeF, alphaLo, alphaHi, spray) => {
    for (let i = 0; i < n; i++) {
      const p = spine[i];
      const u = n > 1 ? i / (n - 1) : 0.5;
      const d = Math.abs(u - 0.5) * 2;

      // Brow hair lies down along the brow, angled up only slightly -- steepest
      // at the bridge, nearly flat by the tails. Steep angles here make the
      // hairs radiate from a point instead of combing in a direction, which is
      // the difference between "bushy brow" and "feather headdress".
      const theta = lerp(Math.PI * 0.25, Math.PI * 0.05, Math.pow(d, 0.6));
      // Blend the sweep direction through the bridge rather than flipping it.
      // A hard flip leaves the two halves parting against each other and cuts a
      // notch out of the middle; easing through zero grows a soft upward tuft.
      const outward = Math.tanh((u - 0.5) * 14);
      const base = norm(add(mul(p.tan, outward * Math.cos(theta)), mul(p.up, Math.sin(theta))));

      const count = Math.round(clamp(p.t * 0.26, 3, 15) * countScale);
      for (let k = 0; k < count; k++) {
        const across = (rnd() - 0.5) * p.t * 0.98;
        const along = (rnd() - 0.5) * opts.spacing * 2.2;
        const root = add(add(p, mul(p.up, across)), mul(p.tan, along));

        const dir = rot(base, (rnd() - 0.5) * spray);
        // Hairs rooted low reach further -- they sweep up over the whole brow.
        const depth = clamp(across / p.t + 0.5, 0, 1);
        const reach = 1 - 0.3 * depth;
        // ...and sit in the brow's own shadow, while the top layer catches the
        // light. Flat-shaded hair is the main thing that reads as "pasted on".
        const lit = lerp(0.74, 1.16, depth);
        const L = p.t * lerp(0.5, 0.95, rnd()) * reach * lenScale * lump(u);

        strands.push({
          x: root.x, y: root.y,
          dx: dir.x, dy: dir.y,
          len: L,
          u,
          curl: (rnd() - 0.5) * 0.42,
          // Signed S-amplitude, scaled by how wavy the head hair measured.
          wave: (rnd() - 0.5) * 2 * waviness * 0.3,
          w: Math.max(0.55, p.t * 0.05 * lerp(0.6, 1.5, rnd()) * widthScale),
          fac: shadeF * lit * lerp(1 - tone.spread, 1 + tone.spread, rnd()),
          alpha: lerp(alphaLo, alphaHi, rnd()),
          layer,
        });
      }
    }
  };

  // Dark bed first, the visible coat over it, then a few pale flyaways on top:
  // that last pass is most of what sells it as bushy rather than painted.
  emit(0, 0.55, 0.85, 1.25, 0.68, 0.4, 0.75, 0.3);
  emit(1, 1.0, 1.0, 1.0, 1.0, 0.5, 0.92, 0.26);
  emit(2, 0.07, 1.2, 0.6, 1.25, 0.22, 0.45, 0.5);

  return strands;
}

// Group strands that can share a stroke. Every hair used to be its own
// beginPath/strokeStyle/stroke, which is thousands of state changes per frame;
// quantising colour and width lets a few hundred paths carry all of them.
//
// Strands within a bucket are still stroked separately, in one pass over a
// shared style: batching them into a single path would make overlaps composite
// once instead of twice, and the doubled darkness where hairs cross is a real
// part of how dense the brow reads.
const QF = 16, QA = 6, QW = 5;
const FAC_LO = 0.3, FAC_HI = 2.0, A_LO = 0.18, A_HI = 0.96;

function bucketStrands(strands, rgb) {
  let wMin = Infinity, wMax = 0;
  for (const s of strands) {
    if (s.w < wMin) wMin = s.w;
    if (s.w > wMax) wMax = s.w;
  }
  const wSpan = wMax - wMin || 1;
  const buckets = new Map();

  for (const s of strands) {
    const fi = Math.round(clamp((s.fac - FAC_LO) / (FAC_HI - FAC_LO), 0, 1) * (QF - 1));
    const ai = Math.round(clamp((s.alpha - A_LO) / (A_HI - A_LO), 0, 1) * (QA - 1));
    const wi = Math.round(((s.w - wMin) / wSpan) * (QW - 1));
    // Layer leads the key so buckets come out in draw order: bed, coat, flyaways.
    const key = ((s.layer * QF + fi) * QA + ai) * QW + wi;
    let b = buckets.get(key);
    if (!b) {
      b = {
        style: shade(rgb, FAC_LO + (fi / (QF - 1)) * (FAC_HI - FAC_LO),
          A_LO + (ai / (QA - 1)) * (A_HI - A_LO)),
        width: wMin + (wi / (QW - 1)) * wSpan,
        items: [],
      };
      buckets.set(key, b);
    }
    b.items.push(s);
  }
  return [...buckets.values()];
}

// ---------------------------------------------------------------- public

/**
 * Measure the face in `srcCtx`, then return a painter for its unibrow.
 * `lm` is a (possibly sparse) array of normalised {x, y} face landmarks.
 *
 * Measuring and painting are separate contexts on purpose: colour must be read
 * off the untouched photo, while the hair goes onto the display canvas.
 */
export function buildUnibrow(srcCtx, lm, w, h, opts = {}) {
  const spacing = opts.spacing ?? 0.9;
  const rnd = mulberry32(opts.seed ?? 0x1bad5eed);
  // Each shot lands a little differently -- same brow, not the same hairs.
  const bush = (opts.bush ?? 1.3) * (0.9 + 0.2 * rnd());

  const rawR = browSpine(lm, BROW_R, w, h);
  const rawL = browSpine(lm, BROW_L, w, h);
  if (!rawR.length || !rawL.length) return null;

  // Colour and native thickness come from the untouched brows, before we
  // exaggerate anything.
  const clock = {};
  const time = (k, fn) => { const t = performance.now(); const v = fn(); clock[k] = +(performance.now() - t).toFixed(2); return v; };

  const brow = time("sampleHair", () => sampleHair(srcCtx, [rawR, rawL], w, h));
  const scalp = time("analyseScalp", () => analyseScalp(srcCtx, lm, w, h));

  const skinL = sampleSkin(srcCtx, lm, w, h);
  const browL = luma(brow.rgb[0], brow.rgb[1], brow.rgb[2]);
  // Nobody has brows that dark next to skin that bright. When this trips, a
  // heavy rim is covering the brow outright and there is nothing there to read.
  const suspect = skinL > 25 && browL < skinL * 0.19;

  let rgb;
  if (suspect && scalp?.hairLike) {
    // Borrow the head's hair instead, a shade darker as brows usually are.
    rgb = mixRgb(scalp.rgb, [0, 0, 0], 0.18);
  } else if (suspect) {
    rgb = brow.rgb.map((v) => clamp(Math.round(v * (skinL * 0.19) / Math.max(browL, 1)), 0, 255));
  } else {
    // Brow colour is the reliable base -- always in frame, never under a hat --
    // but the caterpillar should still look like it belongs to the head it is
    // sitting on, so pull it partway towards the scalp.
    rgb = scalp?.hairLike ? mixRgb(brow.rgb, scalp.rgb, opts.scalpMix ?? 0.38) : brow.rgb;
  }

  const tone = { rgb, spread: brow.spread };
  const waviness = scalp?.hairLike ? scalp.waviness : 0.3;

  // Left/right in image space, whichever brow that turns out to be.
  const [first, second] = centroid(rawR).x <= centroid(rawL).x ? [rawR, rawL] : [rawL, rawR];
  const a = orientOutwardIn(first, centroid(second));
  const b = orientOutwardIn(second, centroid(first)).reverse();

  // Which way is away-from-the-eyes? That's "up" for every hair on the face.
  const eyes = centroid(EYE_REF.map((i) => ({ x: lm[i].x * w, y: lm[i].y * h })));

  // Bridge the gap. A real unibrow doesn't run straight across -- it dips
  // toward the nose where the two brows meet, so the silhouette reads as one
  // continuous curve with a low middle rather than a bar laid over the face.
  // Bowing toward the eye centre keeps that true under head roll.
  const inA = a[a.length - 1], inB = b[0];
  const mid = { x: (inA.x + inB.x) / 2, y: (inA.y + inB.y) / 2 };
  const down = norm(sub(eyes, mid));
  const dip = len(sub(inB, inA)) * (opts.dip ?? 0.22);
  const bridge = [];
  const BRIDGE_STEPS = 12;
  for (let i = 1; i < BRIDGE_STEPS; i++) {
    const f = i / BRIDGE_STEPS;
    const sag = Math.sin(Math.PI * f) * dip;
    bridge.push({
      x: lerp(inA.x, inB.x, f) + down.x * sag,
      y: lerp(inA.y, inB.y, f) + down.y * sag,
      t: lerp(inA.t, inB.t, f) * 1.05,
    });
  }

  // Sample density is capped by count, not by pixel spacing. A phone capture
  // can be several times the size of a laptop one, and fixed spacing would make
  // the strand count -- and every frame of the reveal -- scale with it.
  const coarse = smooth([...a, ...bridge, ...b], 2);
  let run = 0;
  for (let i = 1; i < coarse.length; i++) run += len(sub(coarse[i], coarse[i - 1]));
  const step = Math.max(spacing, run / 420);

  let spine = resample(coarse, step);
  spine = smooth(spine, 3);

  const N = spine.length;
  spine = spine.map((p, i) => {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(N - 1, i + 1)];
    const tan = norm(sub(next, prev));
    let up = { x: -tan.y, y: tan.x };
    if (dot(up, sub(p, eyes)) < 0) up = mul(up, -1);
    return { ...p, tan, up, t0: p.t, t: p.t * bush * envelope(N > 1 ? i / (N - 1) : 0.5) };
  });

  const strands = time("growStrands", () => growStrands(spine, tone, waviness, rnd, { spacing: step }));
  const buckets = time("bucket", () => bucketStrands(strands, tone.rgb));
  const occluders = time("occluders", () =>
    (opts.occlude === false ? null : buildOccluders(srcCtx, spine, w, h)));

  // The growth front starts at the bridge and creeps out to both tails, so the
  // reveal looks like something crawled onto the face rather than faded in.
  const growth = (u, g) => clamp((g - Math.abs(u - 0.5) * 2 * 0.55) / 0.45, 0, 1);
  const N2 = N - 1 || 1;

  const draw = (ctx, progress = 1) => {
    const g = clamp(progress, 0, 1);
    if (g <= 0) return;
    const tBed = performance.now();

    // A soft multiplied bed so skin doesn't glare through the coat.
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.22;
    ctx.filter = `blur(${Math.max(2, spine[0].t * 0.16)}px)`;
    ctx.fillStyle = shade(tone.rgb, 0.85, 1);
    ctx.beginPath();
    spine.forEach((p, i) => {
      const q = add(p, mul(p.up, p.t * 0.42 * growth(i / N2, g)));
      i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    });
    for (let i = spine.length - 1; i >= 0; i--) {
      const p = spine[i];
      const q = add(p, mul(p.up, -p.t * 0.42 * growth(i / N2, g)));
      ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    clock.bed = +(performance.now() - tBed).toFixed(2);
    const tStr = performance.now();

    ctx.save();
    ctx.lineCap = "round";
    for (const bucket of buckets) {
      ctx.strokeStyle = bucket.style;
      ctx.lineWidth = bucket.width;
      for (const s of bucket.items) {
        const L = s.len * growth(s.u, g);
        if (L <= 0.2) continue;
        const px = -s.dy, py = s.dx;
        const bend = s.curl * L;
        const a1 = s.wave * L, a2 = -s.wave * 0.9 * L;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        // Two opposed control offsets give the strand an S: straight hair barely
        // deviates, wavy hair kinks.
        ctx.bezierCurveTo(
          s.x + s.dx * L * 0.33 + px * (bend * 0.25 + a1),
          s.y + s.dy * L * 0.33 + py * (bend * 0.25 + a1),
          s.x + s.dx * L * 0.7 + px * (bend * 0.5 + a2),
          s.y + s.dy * L * 0.7 + py * (bend * 0.5 + a2),
          s.x + s.dx * L + px * bend * 0.55,
          s.y + s.dy * L + py * bend * 0.55,
        );
        ctx.stroke();
      }
    }
    ctx.restore();
    clock.strands = +(performance.now() - tStr).toFixed(2);

    // Frames, fringe and lashes go back over the top.
    if (occluders) ctx.drawImage(occluders.canvas, occluders.x, occluders.y);
  };

  return {
    draw,
    // Callers must dispose when replacing a brow: the occluder layer is a live
    // canvas, and on iOS those count against a budget that fails silently.
    dispose: () => release(occluders?.canvas),
    spine,
    hair: tone,
    browRgb: brow.rgb,
    skinL,
    suspect,
    scalp,
    waviness,
    occluded: occluders ? occluders.coverage : 0,
    strandCount: strands.length,
    clock,
  };
}
