// Real input and dev tools through chrome.debugger (CDP).
import { GLOW_MS } from "./overlay.js";

const attached = new Set();
const monitored = new Set();
const buffers = new Map(); // tabId -> {console:[], network:[]}
const RING = 500;

function dbg(fn) {
  return new Promise((resolve, reject) => {
    fn((r) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(r);
    });
  });
}

const sendRaw = (tabId, method, params = {}) =>
  dbg((cb) => chrome.debugger.sendCommand({ tabId }, method, params, cb));

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try { await dbg((cb) => chrome.debugger.attach({ tabId }, "1.3", cb)); }
  catch (e) { if (!/already attached/i.test(e.message)) throw e; }
  attached.add(tabId);
}

async function detach(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  if (monitored.has(tabId) || !attached.has(tabId)) return;
  attached.delete(tabId);
  try { await dbg((cb) => chrome.debugger.detach({ tabId }, cb)); } catch {}
}

// Stay attached between actions so Chrome's "debugging" bar doesn't flicker
// (and shift the page) on every command. Detach on session end (or idle fallback).
const IDLE_DETACH_MS = GLOW_MS; // same lifetime as the glow: whole session, crash fallback
const idleTimers = new Map(); // tabId -> timeout

/** Attach (or reuse), run fn(send), schedule detach after idle. */
export async function withDebugger(tabId, fn) {
  clearTimeout(idleTimers.get(tabId));
  await attach(tabId);
  try { return await fn((m, p) => sendRaw(tabId, m, p)); }
  finally { idleTimers.set(tabId, setTimeout(() => detach(tabId), IDLE_DETACH_MS)); }
}

/** Detach now (session end). */
export const release = (tabIds) => Promise.all(tabIds.map(detach));

export const insertText = (tabId, text) =>
  withDebugger(tabId, (send) => send("Input.insertText", { text }));

export function mouse(tabId, type, x, y, opts = {}) {
  return withDebugger(tabId, (send) =>
    send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...opts }));
}

export async function click(tabId, x, y) {
  let dispatched = false;
  try {
    await withDebugger(tabId, async (send) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      dispatched = true;
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    });
  } catch (e) {
    // Callers use this to decide whether a DOM click would fire a second time.
    if (e && typeof e === "object") e.dispatched = dispatched;
    throw e;
  }
}

export async function drag(tabId, from, to) {
  await withDebugger(tabId, async (send) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
  });
}

const NAMED = {
  enter: ["Enter", "Enter", 13, "\r"], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46],
  arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
// US layout. charCode is wrong here: "." is 46 (Delete) and '"' is 34 (PageDown).
const UNSHIFTED_PUNCT = {
  ".": ["Period", 190], ",": ["Comma", 188], "/": ["Slash", 191], "'": ["Quote", 222],
  "-": ["Minus", 189], "=": ["Equal", 187], ";": ["Semicolon", 186],
  "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], "`": ["Backquote", 192],
};
const SHIFTED_PUNCT = {
  "!": ["Digit1", 49], "@": ["Digit2", 50], "#": ["Digit3", 51], "$": ["Digit4", 52], "%": ["Digit5", 53],
  "^": ["Digit6", 54], "&": ["Digit7", 55], "*": ["Digit8", 56], "(": ["Digit9", 57], ")": ["Digit0", 48],
  "_": ["Minus", 189], "+": ["Equal", 187], "{": ["BracketLeft", 219], "}": ["BracketRight", 221],
  "|": ["Backslash", 220], ":": ["Semicolon", 186], '"': ["Quote", 222], "<": ["Comma", 188],
  ">": ["Period", 190], "?": ["Slash", 191], "~": ["Backquote", 192],
};
const EDIT = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

/** "Ctrl+Shift+A" -> CDP key event fields. Unmodified printables set `insert` for Input.insertText. */
export function parseCombo(combo) {
  if (combo === " " || combo === "+") {
    if (combo === " ") return { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " ", insert: " ", modifiers: 0 };
    return { key: "+", code: "Equal", windowsVirtualKeyCode: 187, text: "+", modifiers: 8 };
  }
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty key combo");
  let modifiers = 0;
  const keyName = parts.pop();
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}"`);
    modifiers |= bit;
  }
  if (keyName === " " || keyName.toLowerCase() === "space") {
    const out = { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers };
    if (!modifiers) out.insert = " ";
    else if (!(modifiers & ~8)) out.text = " ";
    return out;
  }
  const named = NAMED[keyName.toLowerCase()];
  if (named) return { key: named[0], code: named[1], windowsVirtualKeyCode: named[2], text: named[3], modifiers };
  if ((modifiers & 6) && keyName.length === 1 && /[a-zA-Z]/.test(keyName)) {
    const letter = keyName.toLowerCase();
    const command = letter === "z" && (modifiers & 8) ? "redo" : EDIT[letter];
    const out = { key: keyName, code: "Key" + letter.toUpperCase(), windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), modifiers };
    if (command) out.commands = [command];
    return out;
  }
  const shifted = SHIFTED_PUNCT[keyName];
  if (shifted) {
    const out = {
      key: keyName, code: shifted[0], windowsVirtualKeyCode: shifted[1],
      text: modifiers & ~8 ? undefined : keyName, modifiers: modifiers | 8,
    };
    // Shifted printables (" ? !) must not become key events. '"' is virtual-key 34, PageDown.
    if (!(modifiers & ~8)) out.insert = keyName;
    return out;
  }
  if (keyName.length === 1) {
    const punct = UNSHIFTED_PUNCT[keyName];
    const up = keyName.toUpperCase();
    const isLetter = /[A-Za-z]/.test(keyName);
    const isDigit = /[0-9]/.test(keyName);
    const out = {
      key: keyName,
      code: punct ? punct[0] : isLetter ? "Key" + up : isDigit ? "Digit" + keyName : "",
      windowsVirtualKeyCode: punct ? punct[1] : isLetter ? up.charCodeAt(0) : isDigit ? keyName.charCodeAt(0) : 0,
      modifiers,
    };
    if (!modifiers) { out.insert = keyName; out.text = keyName; }
    else if (!(modifiers & ~8)) out.text = keyName;
    return out;
  }
  throw new Error(`unknown key "${keyName}"`);
}

export async function key(tabId, combo) {
  const k = parseCombo(combo);
  await withDebugger(tabId, async (send) => {
    // Reaffirm focus on the existing DOM focus target. This preserves caret and
    // keyboard behavior for inputs while restoring page-level keys after UI focus changes.
    await send("Page.bringToFront");
    await send("Runtime.evaluate", { expression: "document.activeElement?.focus?.({preventScroll:true})" });
    if (k.insert != null) {
      await send("Input.insertText", { text: k.insert });
      return;
    }
    const { text, commands, ...rest } = k;
    delete rest.insert;
    const down = { type: text || (commands && commands.length) ? "keyDown" : "rawKeyDown", ...rest };
    if (text) down.text = text;
    if (commands && commands.length) down.commands = commands;
    await send("Input.dispatchKeyEvent", down);
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...rest });
  });
}

export async function evaluate(tabId, expression) {
  const r = await withDebugger(tabId, (send) =>
    send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }));
  if (r.exceptionDetails) throw new Error("eval error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value ?? (r.result?.description ?? null);
}

export function setFiles(tabId, files) {
  return withDebugger(tabId, async (send) => {
    const doc = await send("DOM.getDocument", { depth: 0 });
    const q = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "[data-cohand-mark]" });
    if (!q.nodeId) throw new Error("upload target not found");
    await send("DOM.setFileInputFiles", { files, nodeId: q.nodeId });
  });
}

export async function screenshot(tabId, { full = false, zoom } = {}) {
  return withDebugger(tabId, async (send) => {
    const params = { format: "png" };
    if (zoom) {
      const [x0, y0, x1, y1] = zoom;
      params.clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (full) params.captureBeyondViewport = true;
    const r = await send("Page.captureScreenshot", params);
    const scale = await send("Runtime.evaluate", {
      expression: "({dpr:window.devicePixelRatio,zoom:window.visualViewport&&window.visualViewport.scale})",
      returnByValue: true,
    });
    const value = scale.result?.value;
    const dataUrl = "data:image/png;base64," + r.data;
    if (value && typeof value === "object") {
      return { dataUrl, deviceScaleFactor: Number(value.dpr) || 1, pageZoom: value.zoom };
    }
    return { dataUrl, deviceScaleFactor: value || 1 };
  });
}

/** Screenshot image pixels → CSS pixels. `zoom` is visualViewport.scale; ignore it unless it changes the page. */
export function shotToCss(x, y, { dpr, zoom } = {}) {
  const ratio = Number(dpr);
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  let cx = Number(x) / scale;
  let cy = Number(y) / scale;
  const z = Number(zoom);
  if (Number.isFinite(z) && z > 0 && z !== 1) {
    cx /= z;
    cy /= z;
  }
  return { x: cx, y: cy };
}

// ---- console + network buffers (start on first use) ----

const bufOf = (tabId) => {
  if (!buffers.has(tabId)) buffers.set(tabId, { console: [], network: [] });
  return buffers.get(tabId);
};
const push = (arr, item) => { arr.push(item); if (arr.length > RING) arr.shift(); };

let listening = false;
function ensureListener() {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((src, method, p) => {
    const b = buffers.get(src.tabId);
    if (!b) return;
    if (method === "Runtime.consoleAPICalled") {
      push(b.console, { level: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ") });
    } else if (method === "Runtime.exceptionThrown") {
      push(b.console, { level: "exception", text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "" });
    } else if (method === "Network.responseReceived") {
      push(b.network, { status: p.response.status, method: p.type, url: p.response.url });
    } else if (method === "Network.loadingFailed") {
      push(b.network, { status: 0, error: p.errorText, url: p.requestId });
    }
  });
  chrome.debugger.onDetach.addListener((src) => { attached.delete(src.tabId); monitored.delete(src.tabId); });
}

export async function startMonitor(tabId) {
  ensureListener();
  bufOf(tabId);
  if (monitored.has(tabId)) return;
  monitored.add(tabId);
  await attach(tabId);
  await sendRaw(tabId, "Runtime.enable");
  await sendRaw(tabId, "Network.enable");
}

export async function readBuffer(tabId, kind, pattern) {
  const first = !monitored.has(tabId);
  await startMonitor(tabId);
  const items = bufOf(tabId)[kind];
  const re = pattern ? new RegExp(pattern, "i") : null;
  const out = items.filter((i) => !re || re.test(i.text ?? i.url ?? ""));
  return { items: out, note: first ? "capture started now — only events after this call are recorded" : undefined };
}

/** DOM-type, verify it stuck, else fall back to real CDP typing. Pure: all effects injected. */
export async function typeFlow({ domType, readBack, prepareReal, insert }, text, real = false) {
  if (!real) {
    const r = await domType(text);
    if (r?.stuck !== false && (await readBack()) === text) return { method: "dom" };
  }
  await prepareReal();
  await insert(text);
  if ((await readBack()) !== text) throw new Error("typing did not stick even with real input");
  return { method: "cdp" };
}
