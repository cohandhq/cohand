import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { modeFor, isPreAction, overlayEnabled, createTracker, overlayPayload, GLOW_MS } from "../extension/lib/overlay.js";
import { COMMANDS, parseArgs } from "../cli/commands.mjs";

const require = createRequire(import.meta.url);
const core = require("../extension/snapshot-core.js");
const overlaySrc = fs.readFileSync(new URL("../extension/overlay.js", import.meta.url), "utf8");

test("modeFor / isPreAction map commands to overlay styles", () => {
  assert.equal(modeFor("click"), "click");
  assert.equal(modeFor("hover"), "move");
  assert.equal(modeFor("type"), "box");
  assert.equal(modeFor("scroll"), "point");
  assert.equal(modeFor("snapshot"), null);
  assert.equal(isPreAction("click"), true);
  assert.equal(isPreAction("open"), false);
});

test("overlayPayload targets refs, coordinates and none", () => {
  assert.deepEqual(overlayPayload("click", "click", { x: 5, y: 9 }), { mode: "click", glowMs: GLOW_MS, x: 5, y: 9 });
  assert.equal(overlayPayload("type", "box", { ref: "e3" }).ref, "e3");
  assert.deepEqual(overlayPayload("hover", "move", { ref: "10,20" }).x, 10);
  assert.equal(overlayPayload("scroll", "point", {}).ref, undefined);
});

test("--no-show flag and COHAND_NO_SHOW=1 turn the overlay off", () => {
  const prev = process.env.COHAND_NO_SHOW;
  delete process.env.COHAND_NO_SHOW;
  try {
    assert.equal(overlayEnabled(parseArgs(COMMANDS.click, ["e1"]).args), true);
    assert.equal(overlayEnabled(parseArgs(COMMANDS.click, ["e1", "--no-show"]).args), false);
    process.env.COHAND_NO_SHOW = "1";
    assert.equal(overlayEnabled(parseArgs(COMMANDS.click, ["e1"]).args), false);
  } finally {
    if (prev === undefined) delete process.env.COHAND_NO_SHOW; else process.env.COHAND_NO_SHOW = prev;
  }
});

test("tracker: tab is active for the glow window, then not", () => {
  let t = 1000;
  const tr = createTracker(() => t);
  assert.equal(tr.isActive(7), false);
  tr.touch(7);
  t += GLOW_MS - 1;
  assert.equal(tr.isActive(7), true);
  assert.equal(tr.remaining(7), 1);
  t += 2;
  assert.equal(tr.isActive(7), false);
  tr.touch(7); tr.clear(7);
  assert.equal(tr.isActive(7), false);
});

function pageWithOverlay() {
  const d = new JSDOM(`<!doctype html><body><h1>Hi</h1><button id="b">Go</button><p>hello world</p></body>`, { url: "https://x.test/", runScripts: "outside-only" });
  d.window.eval(overlaySrc);
  return d;
}

test("overlay lives outside <body>, hidden from snapshot/find/text, and can suspend/off", () => {
  const d = pageWithOverlay();
  const doc = d.window.document;
  const before = core.buildSnapshot(doc, d.window, {}).text;
  const textBefore = core.getText(doc);
  d.window.__cohandOverlay.show({ mode: "click", x: 40, y: 50 });
  d.window.__cohandOverlay.show({ mode: "box", rect: { left: 1, top: 2, width: 30, height: 20 } });
  const host = doc.querySelector("cohand-overlay");
  assert.ok(host, "overlay mounted");
  assert.equal(host.parentNode, doc.documentElement);
  assert.equal(host.shadowRoot, null, "closed shadow root");
  assert.match(host.style.pointerEvents, /none/);
  assert.equal(core.buildSnapshot(doc, d.window, {}).text, before);
  assert.equal(core.getText(doc), textBefore);
  assert.doesNotMatch(core.buildSnapshot(doc, d.window, { all: true }).text, /cohand-overlay/);
  d.window.__cohandOverlay.suspend(true);
  assert.equal(host.style.visibility, "hidden");
  d.window.__cohandOverlay.suspend(false);
  assert.equal(host.style.visibility, "visible");
  d.window.__cohandOverlay.off();
  assert.equal(doc.querySelector("cohand-overlay"), null);
  d.window.close();
});
