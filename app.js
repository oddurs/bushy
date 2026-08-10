import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
import { buildUnibrow } from "./brow.js";
import { distortFace } from "./warp.js";
import { shotSeed } from "./rng.js";

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const video = $("video");
const shot = $("shot");
const ctx = shot.getContext("2d", { willReadFrequently: true });

const els = {
  count: $("count"), flash: $("flash"), msg: $("overlay-msg"), status: $("status"),
  shoot: $("shoot"), retake: $("retake"), download: $("download"), compare: $("compare"),
};

const params = new URLSearchParams(location.search);
const num = (k, fallback) => {
  const v = parseFloat(params.get(k));
  return Number.isFinite(v) ? v : fallback;
};
const OPTS = {
  bush: num("bush", undefined),
  seed: parseInt(params.get("seed"), 10) || undefined,
  scalpMix: num("scalpMix", undefined),
};
const WARP = num("warp", 1);

// The clean photo, kept aside so the reveal can repaint from scratch each frame
// and so "hold to compare" has something to show.
const original = document.createElement("canvas");
const octx = original.getContext("2d", { willReadFrequently: true });

let landmarker = null;
let faces = [];   // landmarks of the distorted photo, one entry per person
let brows = [];
let seed = 0;     // one seed per shot, driving both the warp and the hair

const setState = (s) => { stage.dataset.state = s; };
const say = (t) => { els.status.textContent = t; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- boot

async function loadLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(MP);
  const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "IMAGE",
    numFaces: 5,
  });
  try {
    return await make("GPU");
  } catch {
    return await make("CPU");
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  }
}

function cameraProblem(err) {
  // Browsers hide getUserMedia entirely outside a secure context, which shows up
  // as a confusing "undefined" rather than a permission error.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return `Cameras only work on https:// or localhost. Open this page at http://127.0.0.1:${location.port || 80} instead of ${location.hostname}.`;
  }
  switch (err?.name) {
    case "NotAllowedError": return "No camera access, no caterpillar. Allow the camera and reload.";
    case "NotFoundError": return "No camera found on this machine.";
    case "NotReadableError": return "Something else is holding the camera — close it and reload.";
    default: return `Couldn't start: ${err?.message || err}`;
  }
}

async function boot() {
  if (params.has("demo")) {
    const { runDemo } = await import("./demo.js");
    return runDemo({ stage, shot, ctx, original, octx, setState, say, opts: OPTS });
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no getUserMedia");
    const camera = startCamera();
    els.msg.textContent = "Warming up…";
    [landmarker] = await Promise.all([loadLandmarker(), camera]);
    setState("live");
    els.shoot.disabled = false;
    say("");
  } catch (err) {
    setState("error");
    els.msg.textContent = cameraProblem(err);
  }
}

// ---------------------------------------------------------------- capture

function beep(freq) {
  try {
    const ac = beep.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.13);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.14);
  } catch { /* audio is a nicety, never a blocker */ }
}

function grabFrame() {
  const w = video.videoWidth, h = video.videoHeight;
  original.width = shot.width = w;
  original.height = shot.height = h;
  // Mirrored to match the preview, so what you saw is what you shot.
  octx.save();
  octx.translate(w, 0);
  octx.scale(-1, 1);
  octx.drawImage(video, 0, 0, w, h);
  octx.restore();
  ctx.drawImage(original, 0, 0);
}

function rebuild() {
  brows = faces
    // Offset per face so two people in one shot don't grow identical hair.
    .map((lm, i) => buildUnibrow(octx, lm, original.width, original.height,
      { ...OPTS, seed: (seed + i * 0x9e3779b1) >>> 0 }))
    .filter(Boolean);
}

function repaint(progress = 1) {
  ctx.clearRect(0, 0, shot.width, shot.height);
  ctx.drawImage(original, 0, 0);
  if (progress > 0) for (const b of brows) b.draw(ctx, progress);
}

function reveal(duration = 950) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      repaint(1 - Math.pow(1 - t, 3));
      t < 1 ? requestAnimationFrame(frame) : resolve();
    };
    requestAnimationFrame(frame);
  });
}

async function shoot() {
  els.shoot.disabled = true;
  setState("counting");
  for (const n of [3, 2, 1]) {
    els.count.textContent = n;
    // restart the pop animation for each digit
    els.count.style.animation = "none";
    void els.count.offsetWidth;
    els.count.style.animation = "";
    beep(n === 1 ? 900 : 620);
    await wait(900);
  }

  grabFrame();
  setState("shot");
  els.flash.classList.add("fire");
  beep(1250);
  setTimeout(() => els.flash.classList.remove("fire"), 450);
  await wait(220);

  setState("working");
  els.msg.textContent = "Cultivating…";
  await wait(30);

  // Everyone in frame gets one. Each is measured off its own brows and its own
  // head, so a group shot doesn't end up sharing one person's hair.
  const found = landmarker.detect(original)?.faceLandmarks ?? [];

  // Distort first, then look again. Re-measuring the warped photo is cheaper to
  // reason about than pushing the old landmarks through the displacement field,
  // and it keeps the brow sitting exactly where the new face is.
  seed = OPTS.seed ?? shotSeed();
  let warped = false;
  found.forEach((lm, i) => {
    warped = distortFace(octx, lm, original.width, original.height, WARP,
      (seed ^ (i * 0x85ebca6b)) >>> 0) || warped;
  });
  if (warped) ctx.drawImage(original, 0, 0);
  faces = warped ? (landmarker.detect(original)?.faceLandmarks ?? found) : found;

  rebuild();

  if (!brows.length) {
    setState("live");
    els.shoot.disabled = false;
    say(faces.length
      ? "Found a face but lost the brows. Try again?"
      : "Couldn't find a face — more light, and look straight at the lens.");
    return;
  }

  setState("result");
  await reveal();
  report();
  els.retake.hidden = els.download.hidden = els.compare.hidden = false;
}

function report() {
  const hairs = brows.reduce((n, b) => n + b.strandCount, 0);
  const wave = brows.reduce((n, b) => n + b.waviness, 0) / brows.length;
  const texture = wave > 0.55 ? "wavy" : wave > 0.32 ? "with a kink" : "straight";
  say(brows.length > 1
    ? `${brows.length} victims · ${hairs.toLocaleString()} new hairs`
    : `${hairs.toLocaleString()} new hairs, ${texture}, matched to your own`);
}

// ---------------------------------------------------------------- controls

els.shoot.addEventListener("click", shoot);

els.retake.addEventListener("click", () => {
  faces = [];
  brows = [];
  setState("live");
  els.shoot.disabled = false;
  els.retake.hidden = els.download.hidden = els.compare.hidden = true;
  say("");
});

els.download.addEventListener("click", () => {
  shot.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const t = new Date();
    const stamp = [t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds()]
      .map((v, i) => String(v).padStart(i ? 2 : 4, "0"));
    a.href = url;
    a.download = `unibrow-${stamp.slice(0, 3).join("")}-${stamp.slice(3).join("")}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
});

const showOriginal = (on) => { if (brows.length) repaint(on ? 0 : 1); };
for (const ev of ["mousedown", "touchstart"]) {
  els.compare.addEventListener(ev, (e) => { e.preventDefault(); showOriginal(true); });
}
for (const ev of ["mouseup", "mouseleave", "touchend", "touchcancel"]) {
  els.compare.addEventListener(ev, () => showOriginal(false));
}

addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.code !== "Enter") return;
  e.preventDefault();
  if (stage.dataset.state === "live" && !els.shoot.disabled) shoot();
  else if (stage.dataset.state === "result") els.retake.click();
});

boot();
