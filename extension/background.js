// cohand — service worker. One job: hold the native-messaging port to cohand-host and
// dispatch daemon commands to executors. Browser know-how lives in executors.js / content.js.

import { exec } from "./executors.js";
import { listAsks, resolveAsk } from "./lib/ask.js";
import { queueSessionChild, rememberActivatedTab } from "./lib/session-tabs.js";

const PROTOCOL_VERSION = 1;
const HOST = "com.cohand.host";

chrome.tabs.onCreated.addListener((tab) => { void queueSessionChild(tab); });
chrome.tabs.onActivated.addListener(({ tabId }) => { void rememberActivatedTab(tabId); });

let port = null;
let backoffMs = 1000;
let connected = false;
let currentProfile = null;
let reconnectTimer = null;
let isFront = false;
let lastFocused = null;

function sendFocus(focused) {
  lastFocused = focused;
  send({ v: PROTOCOL_VERSION, type: "event", event: "focus", data: { focused } });
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  sendFocus(windowId !== chrome.windows.WINDOW_ID_NONE);
});

// ---- popup <-> daemon (requests ride the native port as {type:"req"} / {type:"res"}) ----
const rpcPending = new Map();
let rpcId = 1;

function rpc(op, args = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!port || !connected) return reject(new Error("not connected to cohand daemon"));
    const id = rpcId++;
    const timer = setTimeout(() => { rpcPending.delete(id); reject(new Error("daemon did not answer")); }, timeoutMs);
    rpcPending.set(id, { resolve, reject, timer });
    send({ v: PROTOCOL_VERSION, type: "req", id, op, args });
  });
}

function onRes(frame) {
  const e = rpcPending.get(frame.id);
  if (!e) return;
  rpcPending.delete(frame.id);
  clearTimeout(e.timer);
  if (frame.ok) e.resolve(frame.data); else e.reject(new Error(frame.error || "failed"));
}

async function popupStatus() {
  const { enabled } = await getSettings();
  const base = { enabled, connected, front: isFront, profile: currentProfile, asks: listAsks() };
  try { return { ...base, ...(await rpc("status.profile")) }; }
  catch (e) { return { ...base, error: e.message }; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.getStatus) { sendResponse({ connected, profile: currentProfile, defaultLabel: currentProfile }); return; }
  const done = (p) => { p.then((r) => sendResponse({ ok: true, data: r }), (e) => sendResponse({ ok: false, error: String(e?.message || e) })); return true; };
  if (msg.popup === "status") return done(popupStatus());
  if (msg.popup === "call" && ["policy.block", "policy.anyTab", "session.end"].includes(msg.op)) return done(rpc(msg.op, msg.args));
  if (msg.popup === "ask") return done(Promise.resolve({ resolved: resolveAsk(msg.id, msg.allow === true) }));
});

async function getSettings() {
  try {
    const got = await chrome.storage.local.get({ profileLabel: null, enabled: true });
    return got;
  } catch {
    return { profileLabel: null, enabled: true };
  }
}

const MOODS = ["sleepy", "brave", "curious", "sunny", "nimble", "cosmic", "plucky", "breezy", "jolly", "sneaky", "dapper", "zippy"];
const CRITTERS = ["otter", "falcon", "panda", "fox", "koala", "lynx", "heron", "badger", "gecko", "owl", "yak", "narwhal"];

async function getProfileLabel() {
  const { profileLabel } = await getSettings();
  if (profileLabel && profileLabel.trim()) return profileLabel.trim().slice(0, 64);
  // stable default until the user renames it in the popup
  let { defaultLabel } = await chrome.storage.local.get("defaultLabel");
  if (!defaultLabel || /^chrome-[a-z0-9]{4}$/.test(defaultLabel)) { // replace old random ids
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    defaultLabel = `${pick(MOODS)}-${pick(CRITTERS)}`;
    await chrome.storage.local.set({ defaultLabel });
  }
  return defaultLabel;
}

function log(msg) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  chrome.storage.session.get(["log"], ({ log: prev }) => {
    chrome.storage.session.set({ log: [...(prev || []), line].slice(-50) });
  });
}

function send(obj) {
  try { port?.postMessage(obj); } catch {}
}

async function setBadge() {
  const { enabled } = await getSettings();
  if (!enabled) {
    chrome.action.setBadgeText({ text: "off" });
    chrome.action.setBadgeBackgroundColor({ color: "#da3633" });
  } else if (connected && isFront) {
    chrome.action.setBadgeText({ text: "on" });
    chrome.action.setBadgeBackgroundColor({ color: "#2ea043" });
  } else if (connected) {
    chrome.action.setBadgeText({ text: "··" });
    chrome.action.setBadgeBackgroundColor({ color: "#8a8f98" });
  } else {
    chrome.action.setBadgeText({ text: "…" });
    chrome.action.setBadgeBackgroundColor({ color: "#444444" });
  }
}

let connecting = false;

async function connect() {
  if (port || connecting) return; // exactly one native port, ever
  connecting = true;
  try { await openPort(); } finally { connecting = false; }
}

async function openPort() {
  const { enabled } = await getSettings();
  if (!enabled || port) return;
  const profile = await getProfileLabel();
  currentProfile = profile;
  let p;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    log(`cannot start native host: ${e.message}`);
    scheduleReconnect();
    return;
  }
  port = p;

  p.onMessage.addListener((frame) => {
    if (!connected) { connected = true; backoffMs = 1000; log(`connected as "${profile}"`); setBadge(); }
    if (frame && frame.type === "res") { onRes(frame); return; }
    if (frame && frame.type === "front") { isFront = frame.front === true; setBadge(); return; }
    if (frame && frame.type === "cmd") {
      exec(frame.cmd, frame.args || {})
        .then((data) => send({ v: PROTOCOL_VERSION, id: frame.id, type: "result", ok: true, data: data ?? {} }))
        .catch((err) => send({ v: PROTOCOL_VERSION, id: frame.id, type: "result", ok: false, error: String(err?.message || err) }));
    }
  });

  p.onDisconnect.addListener(() => {
    if (port !== p) return; // a stale port we already replaced
    const why = chrome.runtime.lastError?.message;
    const was = connected;
    port = null;
    connected = false;
    isFront = false;
    if (was) log("disconnected from cohand-host");
    else if (why) log(`native host: ${why}`);
    setBadge();
    scheduleReconnect();
  });

  send({ v: PROTOCOL_VERSION, type: "hello", profile });
  chrome.windows.getLastFocused((w) => {
    void chrome.runtime.lastError;
    sendFocus(!!(w && w.focused));
  });
  // the host does not talk first; treat a clean open as connected after a short beat
  setTimeout(() => { if (port === p && !connected) { connected = true; backoffMs = 1000; setBadge(); } }, 500);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}

function drop() {
  clearTimeout(reconnectTimer);
  try { port?.disconnect(); } catch {}
  port = null;
  connected = false;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("enabled" in changes) {
    if (!changes.enabled.newValue) { log("kill switch engaged — disconnecting"); drop(); }
    else { log("re-enabled — connecting"); backoffMs = 1000; connect(); }
    setBadge();
  }
  if ("profileLabel" in changes) { drop(); backoffMs = 1000; connect(); }
});

chrome.runtime.onInstalled.addListener(() => { log("installed"); setBadge(); connect(); });
chrome.runtime.onStartup.addListener(() => { setBadge(); connect(); });

connect();
setBadge();
