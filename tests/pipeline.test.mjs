// Regression suite.
//
// The measurements are asserted as numbers with tolerances rather than against
// golden images: canvas antialiasing differs subtly between platforms, and a
// suite that goes red when you change machine gets ignored. Renders are still
// checked for byte-level determinism, which is what the reveal animation
// depends on.
//
//   node --test tests/

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium, devices } from "playwright";
import { serve } from "./server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let site, browser;

before(async () => {
  site = await serve(ROOT);
  browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
}, { timeout: 120000 });

after(async () => {
  await browser?.close();
  site?.close();
});

async function page(opts = {}) {
  const p = await browser.newPage({ permissions: ["camera"], ...opts });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error" && !/XNNPACK|Created TensorFlow/.test(m.text())) errors.push(m.text());
  });
  p.errors = errors;
  return p;
}

/** Run the real pipeline over the synthetic face and return its measurements. */
async function measure(query = "") {
  const p = await page();
  await p.goto(`${site.origin}/?demo=1${query}`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(() => window.__demo, null, { timeout: 30000 });
  const info = await p.evaluate(() => window.__demo);
  // Hash the canvas backing store, not an element screenshot. A screenshot goes
  // through CSS scaling and the compositor, which can switch rasterisation paths
  // under load and flake on antialiasing. This measures only what we drew.
  const pixels = await p.evaluate(() => document.getElementById("shot").toDataURL());
  info.hash = createHash("sha1").update(pixels).digest("hex");
  assert.deepEqual(p.errors, [], "console/page errors");
  await p.close();
  return info;
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: got ${actual}, expected ${expected} ±${tol}`);

// ---------------------------------------------------------------- measurement

describe("measurement", () => {
  test("brow colour matches the painted brow", async () => {
    const d = await measure("&brow=4b3020");
    const want = [0x4b, 0x30, 0x20];
    d.browRgb.forEach((v, i) => near(v, want[i], 14, `brow channel ${i}`));
  }, { timeout: 60000 });

  test("light hair is read as light, not clipped dark", async () => {
    const d = await measure("&brow=b09a6e&hair=d8c49a");
    const want = [0xb0, 0x9a, 0x6e];
    d.browRgb.forEach((v, i) => near(v, want[i], 20, `brow channel ${i}`));
    assert.ok(d.scalpRgb[0] > d.browRgb[0], "scalp should read lighter than brow");
  }, { timeout: 60000 });

  test("tone lands between brow and scalp", async () => {
    const d = await measure();
    assert.ok(d.hairLike, "scalp patch should register as hair");
    assert.ok(d.tone[0] > d.browRgb[0] && d.tone[0] < d.scalpRgb[0],
      `tone ${d.tone} should sit between brow ${d.browRgb} and scalp ${d.scalpRgb}`);
  }, { timeout: 60000 });

  test("curly hair measures wavier than straight", async () => {
    const [straight, curly] = [await measure(), await measure("&wavy=1")];
    assert.ok(straight.coherence > curly.coherence,
      `straight hair should be more coherent (${straight.coherence} vs ${curly.coherence})`);
    assert.ok(curly.waviness - straight.waviness > 0.25,
      `waviness should separate clearly (${straight.waviness} -> ${curly.waviness})`);
  }, { timeout: 90000 });
});

// ---------------------------------------------------------------- glasses

describe("glasses", () => {
  test("a rim below the brow does not darken the reading", async () => {
    const [bare, specs] = [await measure(), await measure("&glasses=1")];
    assert.equal(specs.suspect, false, "should trust the brow reading");
    specs.browRgb.forEach((v, i) => near(v, bare.browRgb[i], 8, `brow channel ${i}`));
  }, { timeout: 90000 });

  test("frames are lifted over the hair", async () => {
    const [bare, specs] = [await measure(), await measure("&glasses=1")];
    assert.ok(specs.occluded > bare.occluded * 1.8,
      `occlusion should rise with frames (${bare.occluded} -> ${specs.occluded})`);
  }, { timeout: 90000 });

  test("a rim across the brow is rejected, not trusted", async () => {
    const d = await measure("&rim=252");
    assert.equal(d.suspect, true, "near-black brow reading should be flagged");
    const lum = 0.299 * d.tone[0] + 0.587 * d.tone[1] + 0.114 * d.tone[2];
    assert.ok(lum > d.skinL * 0.19,
      `fallback tone should clear the plausibility floor (${lum} vs ${d.skinL * 0.19})`);
  }, { timeout: 60000 });
});

// ---------------------------------------------------------------- warp

describe("warp", () => {
  test("landmarks carried through the field land within a pixel", async () => {
    for (const q of ["", "&warp=2.5"]) {
      const d = await measure(q);
      assert.ok(d.warped, "warp should apply");
      assert.ok(d.residual < 1,
        `forward map residual should be sub-pixel (got ${d.residual}px at warp${q})`);
    }
  }, { timeout: 90000 });

  test("warp can be disabled", async () => {
    const d = await measure("&warp=0");
    assert.equal(d.warped, false);
    assert.equal(d.residual, 0);
  }, { timeout: 60000 });
});

// ---------------------------------------------------------------- variation

describe("variation", () => {
  test("a seed reproduces exactly", async () => {
    const [a, b] = [await measure("&seed=11"), await measure("&seed=11")];
    assert.equal(a.hash, b.hash, "same seed must render identically");
    assert.equal(a.strands, b.strands);
  }, { timeout: 90000 });

  test("different seeds differ", async () => {
    const runs = [];
    for (const s of [11, 22, 33]) runs.push(await measure(`&seed=${s}`));
    assert.equal(new Set(runs.map((r) => r.hash)).size, 3, "each seed should render differently");
    assert.ok(new Set(runs.map((r) => r.strands)).size > 1, "bushiness should vary");
  }, { timeout: 120000 });

  test("strand count stays bounded", async () => {
    const d = await measure();
    assert.ok(d.strands > 800 && d.strands < 6000, `unexpected strand count ${d.strands}`);
  }, { timeout: 60000 });
});

// ---------------------------------------------------------------- lifecycle

describe("lifecycle", () => {
  test("boots from vendored assets with no third-party requests", async () => {
    const p = await page();
    const external = [];
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (u.origin !== site.origin && u.protocol !== "data:") external.push(u.href);
    });
    await p.goto(site.origin, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#shoot:not([disabled])", { timeout: 90000 });
    assert.deepEqual(external, [], "should not touch the network");
    assert.deepEqual(p.errors, []);
    await p.close();
  }, { timeout: 120000 });

  test("a denied camera fails into a retryable error", async () => {
    const p = await page();
    // The browser is launched with --use-fake-ui-for-media-stream, which grants
    // camera unconditionally, so the denial is injected at the API instead.
    await p.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    });
    await p.goto(site.origin, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => document.getElementById("stage").dataset.state === "error",
      null, { timeout: 90000 });
    assert.equal(await p.isVisible("#action"), true, "error state must offer an action");
    assert.match(await p.textContent("#overlay-msg"), /camera/i);
    await p.close();
  }, { timeout: 120000 });

  test("a dead camera track drops to a resumable paused state", async () => {
    const p = await page();
    await p.goto(site.origin, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#shoot:not([disabled])", { timeout: 90000 });
    // Kill the track, then return to the tab -- the shape of Safari stopping
    // capture while backgrounded. (Calling stop() yourself deliberately does not
    // fire 'ended' per spec, so the visibility check is what has to catch this.)
    await p.evaluate(() => {
      document.getElementById("video").srcObject.getVideoTracks()[0].stop();
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await p.waitForFunction(() => document.getElementById("stage").dataset.state === "paused",
      null, { timeout: 10000 });
    assert.equal(await p.textContent("#action"), "Resume");
    await p.close();
  }, { timeout: 120000 });

  test("an externally ended track is caught too", async () => {
    const p = await page();
    await p.goto(site.origin, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#shoot:not([disabled])", { timeout: 90000 });
    // What a real revoke/unplug delivers, and what WebKit queues on bfcache
    // restore: an 'ended' event the page never asked for.
    await p.evaluate(() => document.getElementById("video").srcObject
      .getVideoTracks()[0].dispatchEvent(new Event("ended")));
    await p.waitForFunction(() => document.getElementById("stage").dataset.state === "paused",
      null, { timeout: 10000 });
    await p.close();
  }, { timeout: 120000 });

  test("capture matches the framing on a phone viewport", async () => {
    const p = await page(devices["iPhone 13"]);
    await p.goto(site.origin, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#shoot:not([disabled])", { timeout: 90000 });
    const vp = await p.evaluate(() => ({
      a: innerWidth / innerHeight,
      scroll: document.documentElement.scrollHeight <= innerHeight + 1,
    }));
    assert.ok(vp.scroll, "page must not scroll");
    await p.tap("#shoot");
    await p.waitForTimeout(4300);
    const c = await p.evaluate(() => ({ w: shot.width, h: shot.height }));
    near(c.w / c.h, vp.a, 0.01, "capture aspect vs viewport aspect");
    assert.ok(Math.max(c.w, c.h) <= 1440, "capture should be capped at 1440px");
    await p.close();
  }, { timeout: 120000 });
});
