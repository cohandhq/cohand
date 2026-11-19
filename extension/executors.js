// cohand — executors. One job: turn daemon commands into chrome.* calls.
// Page work (snapshot/click/type/…) goes to the injected content script; real input via CDP.
// Every command acts only on the session's tab group (see lib/session-tabs.js).

import { targetTab, adoptTab, openInGroup, groupTabs, forgetSession, endSession, pinSessionTab } from "./lib/session-tabs.js";
import * as cdp from "./lib/cdp.js";
import { clickRef } from "./lib/click.js";
import { retryInjected } from "./lib/page-call.js";
import { historyError, watchTabChange } from "./lib/navigation.js";
import { describePageError, isPageErrorMessage } from "./lib/page-errors.js";
import { askUser } from "./lib/ask.js";
import { modeFor, isPreAction, overlayEnabled, createTracker, overlayPayload, SETTLE_MS, GLOW_MS } from "./lib/overlay.js";

const CONTENT_FILES = ["snapshot-core.js", "overlay.js", "content.js"];

function call(cbStyle) {
  return new Promise((resolve, reject) => {
    try {
      cbStyle((result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (e) { reject(e); }
  });
}

const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))]);

async function pick(args) {
  return targetTab(args.session, args.tabId, { anyTab: !!args.anyTab });
}

async function inject(tabId) {
  await call((cb) => chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES }, cb));
}

/** Send a command to the content script in a tab; inject only if it isn't there. */
async function page(tab, cmd, args = {}) {
  const { session, ...rest } = args;
  const send = () => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { __cohand: true, cmd, ...rest }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (!resp) reject(new Error("no response from page"));
      else if (resp.ok) resolve(resp.data || {});
      else reject(new Error(resp.error || "page command failed"));
    });
  });
  try {
    return await retryInjected(send, () => inject(tab.id));
  } catch (e) {
    // Re-injecting fails on a Chrome error page, so map that error too.
    if (isPageErrorMessage(e.message)) throw new Error(describePageError(e.message, tab.url));
    throw e;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const tab = await call((cb) => chrome.tabs.get(tabId, cb));
  if (tab.status === "complete") return tab;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("page load timeout")); }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => call((cb) => chrome.tabs.get(tabId, cb)).then(resolve, reject), 250);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Cheap probe: does scripting work in this tab at all? Returns the failure, or null. */
async function probePage(tabId) {
  try {
    await call((cb) => chrome.scripting.executeScript({ target: { tabId }, func: () => {} }, cb));
    return null;
  } catch (e) { return e; }
}

async function afterNav(tabId, requestedUrl) {
  const t = await waitForTabComplete(tabId).catch(() => null);
  if (t) await new Promise((resolve) => setTimeout(resolve, 250));
  const fresh = await call((cb) => chrome.tabs.get(tabId, cb)).catch(() => t);
  const url = fresh?.url ?? "";
  // Chrome reports an error page as a completed tab, so probe it before handing back "ok".
  const failed = await probePage(tabId);
  if (failed && isPageErrorMessage(failed.message)) throw new Error(describePageError(failed.message, requestedUrl || url));
  return { tabId, url, title: fresh?.title ?? "" };
}

// ---- tab commands ----

async function cmdOpen(a) {
  const tabId = await openInGroup(a.session, a.url, { newTab: !!a.newTab });
  return afterNav(tabId, a.url);
}

async function cmdAdopt(a) {
  return adoptTab(a.session, a.tabId, { anyTab: !!a.anyTab });
}

async function cmdTabs(a) {
  if (a.anyTab) {
    const all = await call((cb) => chrome.tabs.query({}, cb));
    return { tabs: all.map(fmtTab) };
  }
  if (!a.session) throw new Error("no session — run `cohand session start <name>` and export COHAND_SESSION");
  return { tabs: (await groupTabs(a.session)).map(fmtTab), group: `🤖 ${a.session.name}` };
}
const fmtTab = (t) => ({ tabId: t.id, title: t.title || "", url: t.url || "", active: !!t.active, groupId: t.groupId });

async function cmdActivate(a) {
  const t = await pick(a);
  await call((cb) => chrome.tabs.update(t.id, { active: true }, cb));
  if (typeof chrome.windows?.update === "function" && t.windowId != null) {
    await call((cb) => chrome.windows.update(t.windowId, { focused: true }, cb));
  }
  await pinSessionTab(a.session, t.id);
  return { tabId: t.id, title: t.title || "", url: t.url || "" };
}

async function cmdClose(a) {
  const t = await pick(a);
  await call((cb) => chrome.tabs.remove(t.id, cb));
  return {};
}

async function cmdNav(a, how) {
  const t = await pick(a);
  // Back/forward/reload are explicit navigations: wait for the page to finish loading, as before.
  const changed = watchTabChange(t.id, t, { onUpdated: chrome.tabs.onUpdated, getTab: (id) => call((cb) => chrome.tabs.get(id, cb)) }, 800, 15000);
  try {
    if (how === "back") await call((cb) => chrome.tabs.goBack(t.id, cb));
    else if (how === "forward") await call((cb) => chrome.tabs.goForward(t.id, cb));
    else await call((cb) => chrome.tabs.reload(t.id, {}, cb));
  } catch (e) { throw new Error(historyError(how, e)); }
  const fresh = await changed;
  return { tabId: t.id, url: fresh.url || "", title: fresh.title || "" };
}

// ---- reading ----

async function cmdScreenshot(a) {
  const t = await pick(a);
  if (/^(chrome|edge|about|chrome-extension):/i.test(t.url || "") && !a.full) {
    throw new Error(`cannot screenshot internal page "${(t.url || "").slice(0, 60)}"`);
  }
  const hidden = tracker.isActive(t.id);
  if (hidden) await overlayMsg(t.id, { mode: "suspend", on: true }); // keep the overlay out of the picture
  try {
    const screenshot = await withTimeout(cdp.screenshot(t.id, { full: !!(a.full || a.fullPage), zoom: a.zoom }), 20000, "screenshot timed out");
    return screenshot;
  } finally {
    if (hidden) await overlayMsg(t.id, { mode: "suspend", on: false });
  }
}

// ---- acting ----

async function pageMetrics(tabId) {
  const value = await cdp.evaluate(tabId, "({dpr:window.devicePixelRatio,zoom:window.visualViewport&&window.visualViewport.scale})");
  if (value && typeof value === "object") return { dpr: value.dpr, zoom: value.zoom };
  return { dpr: value || 1 };
}

async function cmdClick(a) {
  const t = await pick(a);
  const changed = watchTabChange(t.id, t, { onUpdated: chrome.tabs.onUpdated, getTab: (id) => call((cb) => chrome.tabs.get(id, cb)) });
  if (a.x !== undefined && a.y !== undefined) {
    let x = a.x, y = a.y;
    if (a.fromShot) ({ x, y } = cdp.shotToCss(x, y, await pageMetrics(t.id)));
    await cdp.click(t.id, x, y);
  } else if (a.ref) {
    await clickRef(t, a.ref, { click: cdp.click, send: (cmd, extra) => page(t, cmd, extra) });
  } else {
    await page(t, "click", { ref: a.ref });
  }
  const fresh = await changed;
  return {
    tabId: t.id, url: fresh.url || "", title: fresh.title || "", after: fresh.title || "",
    navigated: !!fresh.navigated, loading: !!fresh.loading,
  };
}

async function cmdUrl(a) {
  const t = await pick(a);
  return { url: t.url || "" };
}

async function cmdType(a) {
  const t = await pick(a);
  const atPoint = a.x !== undefined && a.y !== undefined;
  if (a.focused || atPoint) {
    let x = a.x, y = a.y;
    if (atPoint && a.fromShot) ({ x, y } = cdp.shotToCss(x, y, await pageMetrics(t.id)));
    await page(t, "focus_at", { x, y, focused: !!a.focused }); // password rejection lives in focus_at
    await cdp.insertText(t.id, a.text ?? "");
    if (a.submit) await cdp.key(t.id, "Enter");
    return { method: "cdp" };
  }
  await page(t, "focus_select", { ref: a.ref }); // throws on password fields
  const r = await cdp.typeFlow({
    domType: (text) => page(t, "type", { ref: a.ref, text }),
    readBack: async () => (await page(t, "read_value", { ref: a.ref })).value,
    prepareReal: () => page(t, "focus_select", { ref: a.ref }),
    insert: (text) => cdp.insertText(t.id, text),
  }, a.text, !!a.real);
  if (a.submit) await page(t, "submit", { ref: a.ref });
  return { method: r.method };
}

async function cmdKey(a) {
  const t = await pick(a);
  await cdp.key(t.id, a.combo ?? a.key);
  return {};
}

async function cmdPoint(a, ref) {
  const t = await pick(a);
  const target = typeof ref === "string" && /^\d+,\d+$/.test(ref)
    ? { x: Number(ref.split(",")[0]), y: Number(ref.split(",")[1]) }
    : await page(t, "rect", { ref });
  return { t, target };
}

async function cmdHover(a) {
  const { t, target } = await cmdPoint(a, a.ref);
  await cdp.mouse(t.id, "mouseMoved", target.x, target.y);
  return {};
}

async function cmdDrag(a) {
  const { t, target: from } = await cmdPoint(a, a.ref);
  const { target: to } = await cmdPoint(a, a.to);
  await cdp.drag(t.id, from, to);
  return {};
}

async function cmdUpload(a) {
  const t = await pick(a);
  await page(t, "mark", { ref: a.ref });
  await cdp.setFiles(t.id, [a.file]);
  return {};
}

async function cmdEval(a) {
  const t = await pick(a);
  return { value: await cdp.evaluate(t.id, a.js) };
}

// ---- safety / policy support ----

async function cmdInspect(a) {
  const t = await pick(a);
  const info = await page(t, "inspect", { ref: a.ref, x: a.x, y: a.y, op: a.op, submit: a.submit });
  return { url: info.url || t.url, topUrl: t.url || "", risky: !!info.risky, frameUrls: info.frameUrls || [] };
}

// ---- misc ----

async function cmdCookies(a) {
  const cookies = await call((cb) => chrome.cookies.getAll({ url: a.url }, cb));
  return { cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, httpOnly: !!c.httpOnly })) };
}

async function cmdDownloads(a) {
  if (a.wait) return waitForDownload(a.wait, a.timeoutMs || 30000);
  const items = await call((cb) => chrome.downloads.search({ limit: 15, orderBy: ["-startTime"] }, cb));
  return { downloads: items.map(fmtDl) };
}
const fmtDl = (d) => ({ state: d.state, filename: (d.filename || "").split("/").pop() || d.filename, url: d.finalUrl || d.url });

function waitForDownload(nameContains, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      call((cb) => chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] }, cb)).then((items) => {
        const hit = items.find((d) => (d.filename || "").toLowerCase().includes(String(nameContains).toLowerCase()));
        if (hit && hit.state === "complete") return resolve({ downloads: [fmtDl(hit)] });
        if (Date.now() - started > timeoutMs) return reject(new Error("download wait timeout"));
        setTimeout(poll, 500);
      }, reject);
    }
    poll();
  });
}

// ---- on-screen overlay (glow, ghost cursor). Cosmetic: failures here never fail an action. ----

const tracker = createTracker();

function overlayMsg(tabId, payload) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { __cohand: true, cmd: "overlay", ...payload }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

async function showOverlay(tabId, payload) {
  tracker.touch(tabId);
  await overlayMsg(tabId, payload);
}

async function preShow(cmd, mode, args) {
  try {
    const t = await pick(args);
    if (!t || /^(chrome|edge|about|chrome-extension):/i.test(t.url || "")) return;
    try { await inject(t.id); } catch { return; } // overlay.js is idempotent; skip pages we can't script
    await showOverlay(t.id, overlayPayload(cmd, mode, args));
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  } catch { /* the real command reports its own errors */ }
}

async function postGlow(cmd, args, res) {
  try {
    const tabId = res?.tabId ?? (await pick(args)).id;
    if (typeof tabId === "number") await showOverlay(tabId, { mode: "glow", glowMs: GLOW_MS });
  } catch { /* cosmetic */ }
}

// A new page in a tab with a live glow window gets the overlay again.
if (typeof chrome !== "undefined" && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== "complete" || !tracker.isActive(tabId)) return;
    inject(tabId).then(() => overlayMsg(tabId, { mode: "glow", glowMs: tracker.remaining(tabId) }), () => {});
  });
}

export async function exec(cmd, args) {
  const mode = overlayEnabled(args) ? modeFor(cmd) : null;
  if (mode && isPreAction(cmd)) await preShow(cmd, mode, args);
  const res = await run(cmd, args);
  if (mode && !isPreAction(cmd)) await postGlow(cmd, args, res);
  return res;
}

async function endOverlays(session) {
  try {
    for (const t of await groupTabs(session)) { tracker.clear(t.id); await overlayMsg(t.id, { mode: "off" }); }
  } catch { /* cosmetic */ }
}

async function run(cmd, args) {
  switch (cmd) {
    case "open": return cmdOpen(args);
    case "adopt": return cmdAdopt(args);
    case "tabs": return cmdTabs(args);
    case "url": return cmdUrl(args);
    case "activate": return cmdActivate(args);
    case "close": return cmdClose(args);
    case "back": case "forward": case "reload": return cmdNav(args, cmd);
    case "snapshot": return page(await pick(args), "snapshot", { scope: args.scope, page: args.page });
    case "text": case "get_text": return page(await pick(args), "get_text", { selector: args.selector });
    case "find": return page(await pick(args), "find", { query: args.query });
    case "screenshot": return cmdScreenshot(args);
    case "click": return cmdClick(args);
    case "type": return cmdType(args);
    case "key": case "press": return cmdKey(args);
    case "scroll": return page(await pick(args), "scroll", { direction: args.direction, amount: args.amount });
    case "hover": return cmdHover(args);
    case "select": return page(await pick(args), "select", { ref: args.ref, value: args.value });
    case "drag": return cmdDrag(args);
    case "upload": return cmdUpload(args);
    case "wait": case "wait_for":
      return page(await pick(args), "wait_for", { text: args.text, selector: args.selector, idle: args.idle, timeoutMs: args.timeoutMs });
    case "eval": return cmdEval(args);
    case "console": { const t = await pick(args); return cdp.readBuffer(t.id, "console", args.pattern); }
    case "network": { const t = await pick(args); return cdp.readBuffer(t.id, "network", args.pattern); }
    case "cookies": return cmdCookies(args);
    case "downloads": return cmdDownloads(args);
    case "inspect": return cmdInspect(args);
    case "ask": return askUser(args.summary, undefined, args.askId);
    case "session.end":
      await endOverlays(args.session);
      await cdp.release((await groupTabs(args.session)).map((t) => t.id));
      await endSession(args.session); return {};
    default: throw new Error("unknown_cmd: " + cmd);
  }
}

export { forgetSession };
