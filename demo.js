// Dev harness: paint a synthetic face with known brows, hair and (optionally)
// glasses, then run the real pipeline over it. Lets the renderer be inspected
// and the measurements checked without a webcam.
//
//   ?demo=1              straight dark hair, no glasses
//   &wavy=1              curly hair (should measure a higher waviness)
//   &glasses=1           spectacles whose top rim crosses the brow
//   &hair=c9a86a         scalp colour   &brow=4b3020   brow colour
//   &p=0.4               freeze the reveal partway
//
// Not used by the app itself; safe to delete.

import { buildUnibrow } from "./brow.js";
import { distortFace, mapLandmarks, mapResidual } from "./warp.js";
import { mulberry32 } from "./rng.js";

// Seeded before painting, so the synthetic face is byte-identical run to run
// and screenshots stay comparable.
let R = Math.random;

const W = 900, H = 700;
const CX = 450;

// x from outer to inner, mirrored for the other side.
const XS = [300, 330, 360, 390, 420];
const UPPER_Y = [250, 243, 240, 243, 249];
const LOWER_Y = [264, 257, 254, 257, 262];

const put = (lm, idx, x, y) => { lm[idx] = { x: x / W, y: y / H }; };

function landmarks() {
  const lm = [];
  const R = { upper: [70, 63, 105, 66, 107], lower: [46, 53, 52, 65, 55] };
  const L = { upper: [300, 293, 334, 296, 336], lower: [276, 283, 282, 295, 285] };
  XS.forEach((x, i) => {
    put(lm, R.upper[i], x, UPPER_Y[i]);
    put(lm, R.lower[i], x, LOWER_Y[i]);
    put(lm, L.upper[i], 2 * CX - x, UPPER_Y[i]);
    put(lm, L.lower[i], 2 * CX - x, LOWER_Y[i]);
  });
  [[33, 300], [133, 420], [362, 480], [263, 600]].forEach(([i, x]) => put(lm, i, x, 300));
  [[159, 360, 281], [145, 360, 319], [386, 540, 281], [374, 540, 319]]
    .forEach(([i, x, y]) => put(lm, i, x, y));   // eyelids
  put(lm, 9, CX, 258);    // glabella
  put(lm, 10, CX, 190);   // hairline
  put(lm, 152, CX, 630);  // chin
  put(lm, 1, CX, 412);    // nose tip
  put(lm, 234, 232, 335); // ear level, widest points of the face
  put(lm, 454, 668, 335);
  put(lm, 61, 395, 481);  // mouth corners
  put(lm, 291, 505, 481);
  return lm;
}

function paintScalp(g, colour, wavy) {
  g.save();
  g.beginPath();
  g.ellipse(CX, 350, 222, 287, 0, 0, Math.PI * 2);
  g.clip();
  g.strokeStyle = colour;
  g.lineWidth = 2.2;
  g.lineCap = "round";
  for (let k = 0; k < 2600; k++) {
    const x = CX - 230 + R() * 460;
    const y = 40 + R() * 165;
    g.globalAlpha = 0.35 + R() * 0.6;
    g.beginPath();
    g.moveTo(x, y);
    if (wavy) {
      // tight alternating curls -> gradients point every which way
      const amp = 7 + R() * 6;
      const s = R() < 0.5 ? 1 : -1;
      g.bezierCurveTo(x + s * amp, y + 9, x - s * amp, y + 18, x + s * amp * 0.4, y + 27);
    } else {
      // near-parallel combed strands -> gradients share one axis
      g.lineTo(x + 3 + R() * 3, y + 26 + R() * 8);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  g.restore();
}

// rimY defaults just under the brow (the realistic case). Pass &rim=252 to put
// the rim straight across the brow and exercise the near-black guard.
function paintGlasses(g, rimY) {
  g.strokeStyle = "#14100e";
  g.lineWidth = 9;
  g.lineJoin = "round";
  for (const ex of [360, 540]) {
    g.beginPath();
    g.roundRect(ex - 76, rimY, 152, 104, 16);
    g.stroke();
  }
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(436, rimY + 16); g.lineTo(464, rimY + 16);        // bridge
  g.moveTo(284, rimY + 10); g.lineTo(232, rimY - 2);         // temples
  g.moveTo(616, rimY + 10); g.lineTo(668, rimY - 2);
  g.stroke();
}

function paintFace(g, browColour, scalpColour, opts) {
  g.fillStyle = "#15100d";
  g.fillRect(0, 0, W, H);

  const skin = g.createRadialGradient(CX, 300, 40, CX, 340, 330);
  skin.addColorStop(0, "#e8c3a4");
  skin.addColorStop(1, "#bf9271");

  g.fillStyle = "#cf9f7d";
  for (const ex of [232, 668]) {
    g.beginPath();
    g.ellipse(ex, 335, 26, 44, 0, 0, Math.PI * 2);
    g.fill();
  }

  g.fillStyle = skin;
  g.beginPath();
  g.ellipse(CX, 350, 220, 285, 0, 0, Math.PI * 2);
  g.fill();

  for (const ex of [360, 540]) {
    g.fillStyle = "#fbf7f2";
    g.beginPath();
    g.ellipse(ex, 300, 42, 20, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#4a352a";
    g.beginPath();
    g.arc(ex, 300, 16, 0, Math.PI * 2);
    g.fill();
  }

  g.strokeStyle = "#a97a5c";
  g.lineWidth = 5;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(CX, 330); g.lineTo(CX - 14, 410); g.lineTo(CX + 12, 416);
  g.stroke();
  g.beginPath();
  g.moveTo(CX - 55, 480); g.quadraticCurveTo(CX, 512, CX + 55, 480);
  g.stroke();

  // Real-ish brow texture: individual strokes over skin, so the colour
  // sampler faces the same hair/skin mixture it will see on a photo.
  g.lineWidth = 1.6;
  g.strokeStyle = browColour;
  for (const side of [1, -1]) {
    for (let k = 0; k < 900; k++) {
      const f = k / 900;
      const i = Math.min(XS.length - 2, Math.floor(f * (XS.length - 1)));
      const t = f * (XS.length - 1) - i;
      const x = CX + side * (XS[i] + (XS[i + 1] - XS[i]) * t - CX);
      const yU = UPPER_Y[i] + (UPPER_Y[i + 1] - UPPER_Y[i]) * t;
      const yL = LOWER_Y[i] + (LOWER_Y[i + 1] - LOWER_Y[i]) * t;
      const y = yU + R() * (yL - yU);
      const dir = side * (0.7 + R() * 0.5);
      g.globalAlpha = 0.5 + R() * 0.5;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - dir * 9, y - 3 - R() * 4);
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  paintScalp(g, scalpColour, opts.wavy);
  if (opts.glasses) paintGlasses(g, opts.rim);
}

export function runDemo({ shot, ctx, original, octx, setState, say, opts }) {
  const params = new URLSearchParams(location.search);
  const flags = {
    wavy: params.has("wavy"),
    glasses: params.has("glasses") || params.has("rim"),
    rim: parseFloat(params.get("rim")) || 270,
  };

  // Fixed unless asked otherwise, so screenshots stay comparable run to run.
  const seed = opts.seed ?? 0x1bad5eed;
  R = mulberry32(seed ^ 0x9e37);

  original.width = shot.width = W;
  original.height = shot.height = H;
  paintFace(octx, `#${params.get("brow") || "4b3020"}`, `#${params.get("hair") || "8a6a43"}`, flags);
  ctx.drawImage(original, 0, 0);

  const lm = landmarks();
  const warpAmt = params.has("warp") ? parseFloat(params.get("warp")) : 1;
  const tw = performance.now();
  const cs = distortFace(octx, lm, W, H, warpAmt, seed);
  const warpMs = performance.now() - tw;
  if (cs) ctx.drawImage(original, 0, 0);

  // Same path the app takes: carry the landmarks through the field instead of
  // detecting again. Residual is how far that misses the exact inverse.
  const moved = cs ? mapLandmarks(cs, lm, W, H) : lm;
  let residual = 0;
  if (cs) {
    lm.forEach((p, i) => {
      if (!p || !moved[i]) return;
      residual = Math.max(residual,
        mapResidual(cs, p.x * W, p.y * H, moved[i].x * W, moved[i].y * H));
    });
  }

  const t0 = performance.now();
  const uni = buildUnibrow(octx, moved, W, H, { ...opts, seed });
  const build = performance.now() - t0;

  setState("result");
  for (const id of ["retake", "download"]) document.getElementById(id).hidden = false;
  if (!uni) {
    say("demo: build failed");
    window.__demo = { ok: false };
    return;
  }

  const p = parseFloat(params.get("p"));
  const t1 = performance.now();
  uni.draw(ctx, Number.isFinite(p) ? p : 1);
  const paint = performance.now() - t1;

  window.__demo = {
    ok: true,
    strands: uni.strandCount,
    tone: uni.hair.rgb,
    browRgb: uni.browRgb,
    scalpRgb: uni.scalp?.rgb ?? null,
    hairLike: uni.scalp?.hairLike ?? false,
    skinL: Math.round(uni.skinL),
    suspect: uni.suspect,
    coherence: uni.scalp ? +uni.scalp.coherence.toFixed(3) : null,
    texture: uni.scalp ? +uni.scalp.texture.toFixed(1) : null,
    waviness: +uni.waviness.toFixed(3),
    occluded: +uni.occluded.toFixed(4),
    warped: !!cs,
    residual: +residual.toFixed(3),
    warpMs: +warpMs.toFixed(1),
    buildMs: +build.toFixed(1),
    paintMs: +paint.toFixed(1),
  };
  say(`demo — ${uni.strandCount.toLocaleString()} strands · wave ${uni.waviness.toFixed(2)} · build ${build.toFixed(0)}ms paint ${paint.toFixed(0)}ms`);
}
