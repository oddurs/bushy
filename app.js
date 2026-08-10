import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
import { buildUnibrow } from "./brow.js";
import { distortFace } from "./warp.js";
import { shotSeed } from "./rng.js";

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// Caps the captured photo's longest side. Phone cameras will happily hand over
// something enormous, and every downstream cost -- the warp, the strand count,
// each frame of the reveal -- scales with it.
const MAX_SIDE = 1440;

const $ = (id) => document.getElementById(id);
const stage = $("stage");
const video = $("video");
const shot = $("shot");
const ctx = shot.getContext("2d", { willReadFrequently: true });

const els = {
  count: $("count"), flash: $("flash"), msg: $("overlay-msg"), status: $("status"),
  shoot: $("shoot"), retake: $("retake"), download: $("download"), flip: $("flip"),
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
  dip: num("dip", undefined),
};
const WARP = num("warp", 1);

// The clean photo, kept aside so the reveal can repaint from scratch each frame.
const original = document.createElement("canvas");
const octx = original.getContext("2d", { willReadFrequently: true });

let landmarker = null;
let stream = null;
let facing = "user";
let mirrored = true;
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

async function startCamera(mode = facing) {
  stream?.getTracks().forEach((t) => t.stop());
  // Ask for a stream shaped like the screen. Without this a portrait phone gets
  // a landscape stream, and cropping it to a tall frame throws away most of the
  // pixels -- leaving too little face to measure a brow from.
  const portrait = innerHeight >= innerWidth;
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: mode,
      width: { ideal: portrait ? 1080 : 1440 },
      height: { ideal: portrait ? 1440 : 1080 },
    },
    audio: false,
  });
  facing = mode;
  mirrored = mode === "user";
  video.classList.toggle("mirror", mirrored);
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  }
}

async function offerFlip() {
  try {
    // Device labels and the full list only appear once permission is granted.
    const devices = await navigator.mediaDevices.enumerateDevices();
    els.flip.hidden = devices.filter((d) => d.kind === "videoinput").length < 2;
  } catch {
    els.flip.hidden = true;
  }
}

function cameraProblem(err) {
  // Browsers hide getUserMedia entirely outside a secure context, which shows up
  // as a confusing "undefined" rather than a permission error.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return "Cameras only work over https:// or on localhost.";
  }
  switch (err?.name) {
    case "NotAllowedError": return "No camera access, no caterpillar. Allow the camera and reload.";
    case "NotFoundError": return "No camera found on this device.";
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
    offerFlip();
  } catch (err) {
    setState("error");
    els.msg.textContent = cameraProblem(err);
  }
}

// ---------------------------------------------------------------- capture

function beep(freq) {
  const ac = beep.ac;
  if (!ac) return;
  try {
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

// iOS only lets audio start from inside a user gesture, so the context is
// created and resumed on the tap itself rather than lazily mid-countdown.
function unlockAudio() {
  try {
    beep.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    if (beep.ac.state === "suspended") beep.ac.resume();
  } catch { /* no audio, no problem */ }
}

function grabFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  // Reproduce the object-fit: cover crop exactly, so the saved photo is the
  // photo that was framed rather than the whole sensor.
  const aspect = stage.clientWidth / stage.clientHeight;
  let sw = vw, sh = vh;
  if (vw / vh > aspect) sw = vh * aspect;
  else sh = vw / aspect;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  original.width = shot.width = w;
  original.height = shot.height = h;
  octx.save();
  if (mirrored) { octx.translate(w, 0); octx.scale(-1, 1); }
  octx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
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
  unlockAudio();
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
  els.retake.hidden = els.download.hidden = false;
}

// ---------------------------------------------------------------- controls

els.shoot.addEventListener("click", shoot);

els.flip.addEventListener("click", async () => {
  els.flip.disabled = true;
  try {
    await startCamera(facing === "user" ? "environment" : "user");
  } catch {
    await startCamera(facing).catch(() => {});
  }
  els.flip.disabled = false;
});

els.retake.addEventListener("click", () => {
  faces = [];
  brows = [];
  setState("live");
  els.shoot.disabled = false;
  els.retake.hidden = els.download.hidden = true;
  say("");
});

function filename() {
  const t = new Date();
  const p = (v, n = 2) => String(v).padStart(n, "0");
  return `bushy-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`
    + `-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.png`;
}

els.download.addEventListener("click", async () => {
  const blob = await new Promise((r) => shot.toBlob(r, "image/png"));
  if (!blob) return;
  const file = new File([blob], filename(), { type: "image/png" });

  // On a phone the share sheet is what people actually want -- save to Photos,
  // send it to someone. An <a download> there tends to just open the image.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
});

addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.code !== "Enter") return;
  e.preventDefault();
  if (stage.dataset.state === "live" && !els.shoot.disabled) shoot();
  else if (stage.dataset.state === "result") els.retake.click();
});

boot();
