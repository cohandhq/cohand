import { test } from "node:test";
import assert from "node:assert/strict";
import { click, key, screenshot, release, parseCombo, shotToCss } from "../extension/lib/cdp.js";

test("page keys bring the session tab forward and preserve the current DOM focus", async () => {
  const calls = [];
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      attach(_target, _version, cb) { cb(); },
      detach(_target, cb) { cb(); },
      sendCommand(_target, method, params, cb) { calls.push({ method, params }); cb({}); },
    },
  };
  await key(44, "PageUp");
  await release([44]);
  assert.deepEqual(calls.map((c) => c.method), [
    "Page.bringToFront", "Runtime.evaluate", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
  ]);
  assert.match(calls[1].params.expression, /document\.activeElement/);
  assert.equal(calls[2].params.key, "PageUp");
});

test("screenshots include the browser device scale factor", async () => {
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      attach(_target, _version, cb) { cb(); },
      detach(_target, cb) { cb(); },
      sendCommand(_target, method, _params, cb) {
        cb(method === "Page.captureScreenshot" ? { data: "cG5n" } : { result: { value: 2 } });
      },
    },
  };
  const result = await screenshot(45);
  await release([45]);
  assert.equal(result.dataUrl, "data:image/png;base64,cG5n");
  assert.equal(result.deviceScaleFactor, 2);
});

test("a click that never attaches is tagged as not dispatched", async () => {
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      attach(_target, _version, cb) {
        chrome.runtime.lastError = { message: "Cannot access a chrome:// URL" };
        cb();
        chrome.runtime.lastError = undefined;
      },
      detach(_target, cb) { cb(); },
      sendCommand() { throw new Error("no event may be sent without attaching"); },
    },
  };
  await assert.rejects(click(60, 10, 10), (e) => e.dispatched === false);
});

test("a click that fails after a mouse event is tagged as dispatched", async () => {
  let sent = 0;
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      attach(_target, _version, cb) { cb(); },
      detach(_target, cb) { cb(); },
      sendCommand(_target, _method, _params, cb) {
        sent++;
        if (sent > 1) chrome.runtime.lastError = { message: "Input.dispatchMouseEvent timed out" };
        cb({});
        chrome.runtime.lastError = undefined;
      },
    },
  };
  try {
    await assert.rejects(click(61, 10, 10), (e) => e.dispatched === true);
  } finally {
    await release([61]);
  }
  assert.equal(sent, 2, "the first mouse event reached the page");
});

test("parseCombo uses US virtual-key codes and insertText for unmodified printables", () => {
  const dot = parseCombo(".");
  assert.equal(dot.windowsVirtualKeyCode, 190);
  assert.equal(dot.insert, ".");
  assert.notEqual(dot.windowsVirtualKeyCode, 46);
  const quote = parseCombo('"');
  assert.equal(quote.windowsVirtualKeyCode, 222);
  assert.equal(quote.insert, '"');
  assert.notEqual(quote.windowsVirtualKeyCode, 34);
  assert.equal(quote.modifiers & 8, 8);
  assert.equal(parseCombo("!").windowsVirtualKeyCode, 49);
  assert.equal(parseCombo("?").windowsVirtualKeyCode, 191);
  assert.equal(parseCombo("<").windowsVirtualKeyCode, 188);
  assert.equal(parseCombo("@").windowsVirtualKeyCode, 50);
  assert.ok(parseCombo("Meta+a").commands.includes("selectAll"));
  assert.ok(parseCombo("Ctrl+A").commands.includes("selectAll"));
  assert.deepEqual(parseCombo("Meta+c").commands, ["copy"]);
  assert.deepEqual(parseCombo("Ctrl+x").commands, ["cut"]);
  assert.deepEqual(parseCombo("Meta+v").commands, ["paste"]);
  assert.deepEqual(parseCombo("Ctrl+z").commands, ["undo"]);
  assert.deepEqual(parseCombo("Ctrl+Shift+z").commands, ["redo"]);
  assert.deepEqual(parseCombo("Meta+Shift+Z").commands, ["redo"]);
  assert.equal(parseCombo("Space").insert, " ");
});

test("printable keys insert text and named keys still dispatch", async () => {
  const calls = [];
  globalThis.chrome = {
    runtime: { lastError: undefined },
    debugger: {
      attach(_target, _version, cb) { cb(); },
      detach(_target, cb) { cb(); },
      sendCommand(_target, method, params, cb) { calls.push({ method, params }); cb({}); },
    },
  };
  await key(46, ".");
  assert.deepEqual(calls.map((c) => c.method), ["Page.bringToFront", "Runtime.evaluate", "Input.insertText"]);
  assert.equal(calls[2].params.text, ".");
  assert.equal(calls.some((c) => c.method === "Input.dispatchKeyEvent"), false);
  calls.length = 0;
  await key(46, "Space");
  assert.equal(calls.some((c) => c.method === "Input.insertText" && c.params.text === " "), true);
  assert.equal(calls.some((c) => c.method === "Input.dispatchKeyEvent"), false);
  calls.length = 0;
  await key(46, "Meta+a");
  const down = calls.find((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown");
  assert.ok(down);
  assert.deepEqual(down.params.commands, ["selectAll"]);
  assert.equal(calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyUp" && c.params.commands), false);
  await release([46]);
});

test("shotToCss divides by devicePixelRatio and by a non-1 page zoom", () => {
  assert.deepEqual(shotToCss(200, 100, { dpr: 2 }), { x: 100, y: 50 });
  assert.deepEqual(shotToCss(200, 100, { dpr: 2, zoom: 1 }), { x: 100, y: 50 });
  assert.deepEqual(shotToCss(100, 50, { dpr: 2, zoom: 0.5 }), { x: 100, y: 50 });
  assert.deepEqual(shotToCss(90, 30, { dpr: 1, zoom: 0 }), { x: 90, y: 30 });
});
