// Session tab groups: an agent session only ever touches tabs inside its own group.

export const NO_TABS = "no tabs in session group — drag a tab in or cohand open";
export const groupTitle = (name) => `🤖 ${name}`;

const lastUsed = new Map(); // session id -> tabId
const sessionsByGroup = new Map(); // group id (string key) -> session
const pendingAdoptions = new Set();
const LAST_USED_KEY = "cohandLastUsed";
const SESSIONS_BY_GROUP_KEY = "cohandSessionsByGroup";

function sessionStorageArea() {
  const area = globalThis.chrome?.storage?.session;
  if (!area || typeof area.get !== "function" || typeof area.set !== "function") return null;
  return area;
}

function storageGetMap(area, key) {
  return new Promise((resolve, reject) => {
    try {
      area.get(key, (out) => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else {
          const map = out && out[key];
          resolve(map && typeof map === "object" ? map : {});
        }
      });
    } catch (e) { reject(e); }
  });
}

function storageSetMap(area, key, map) {
  return new Promise((resolve, reject) => {
    try {
      area.set({ [key]: map }, () => {
        const err = globalThis.chrome?.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    } catch (e) { reject(e); }
  });
}

/** Remember the selected tab in memory and, when the service worker can, in session storage. */
async function setLastUsed(sessionId, tabId) {
  lastUsed.set(sessionId, tabId);
  const area = sessionStorageArea();
  if (!area) return;
  try {
    const all = { ...(await storageGetMap(area, LAST_USED_KEY)) };
    all[sessionId] = tabId;
    await storageSetMap(area, LAST_USED_KEY, all);
  } catch { /* the in-memory map still answers this service-worker lifetime */ }
}

async function readLastUsed(sessionId) {
  if (lastUsed.has(sessionId)) return lastUsed.get(sessionId);
  const area = sessionStorageArea();
  if (!area) return undefined;
  try {
    const all = await storageGetMap(area, LAST_USED_KEY);
    if (all[sessionId] === undefined) return undefined;
    lastUsed.set(sessionId, all[sessionId]);
    return all[sessionId];
  } catch { return undefined; }
}

async function dropStoredLastUsed(sessionId) {
  const area = sessionStorageArea();
  if (!area) return;
  try {
    const all = { ...(await storageGetMap(area, LAST_USED_KEY)) };
    if (all[sessionId] === undefined) return;
    delete all[sessionId];
    await storageSetMap(area, LAST_USED_KEY, all);
  } catch { /* forgotten in memory already */ }
}

/** A group id is only meaningful to Chrome while it exists; -1 means "not grouped". */
function groupStorageKey(groupId) {
  if (groupId == null) return null;
  const key = String(groupId);
  return key === "-1" ? null : key;
}

function storedSession(value) {
  if (!value || typeof value !== "object") return null;
  const id = value.id;
  if ((typeof id !== "string" && typeof id !== "number") || id === "") return null;
  return { id, name: typeof value.name === "string" ? value.name : "" };
}

// Serialize storage read/modify/write cycles so concurrent group bookkeeping cannot
// overwrite each other's entries. Failures stay contained: memory remains the fallback.
let sessionMapWrites = Promise.resolve();

function persistGroupSession(groupId, session) {
  const key = groupStorageKey(groupId);
  if (!key) return sessionMapWrites;
  const value = { id: session.id, name: session.name };
  sessionMapWrites = sessionMapWrites.then(async () => {
    const area = sessionStorageArea();
    if (!area) return;
    const all = { ...(await storageGetMap(area, SESSIONS_BY_GROUP_KEY)) };
    all[key] = value;
    await storageSetMap(area, SESSIONS_BY_GROUP_KEY, all);
  }).catch(() => {});
  return sessionMapWrites;
}

/** Remember which session owns a group in memory and, when possible, in session storage. */
async function rememberGroupSession(groupId, session) {
  const key = groupStorageKey(groupId);
  if (!key || !session?.id) return;
  sessionsByGroup.set(key, session);
  await persistGroupSession(groupId, session);
}

/** The session owning a group. Memory answers first; storage covers a fresh service worker. */
export async function getSessionForGroup(groupId) {
  const key = groupStorageKey(groupId);
  if (!key) return undefined;
  const cached = sessionsByGroup.get(key);
  if (cached) return cached;
  const area = sessionStorageArea();
  if (!area) return undefined;
  try {
    const all = await storageGetMap(area, SESSIONS_BY_GROUP_KEY);
    const session = storedSession(all[key]);
    if (!session) return undefined;
    sessionsByGroup.set(key, session);
    return session;
  } catch { return undefined; }
}

function dropStoredSessionsForSession(sessionId) {
  sessionMapWrites = sessionMapWrites.then(async () => {
    const area = sessionStorageArea();
    if (!area) return;
    const all = { ...(await storageGetMap(area, SESSIONS_BY_GROUP_KEY)) };
    let changed = false;
    for (const [groupId, value] of Object.entries(all)) {
      if (storedSession(value)?.id === sessionId) {
        delete all[groupId];
        changed = true;
      }
    }
    if (changed) await storageSetMap(area, SESSIONS_BY_GROUP_KEY, all);
  }).catch(() => {});
  return sessionMapWrites;
}

/** Drop in-memory tab state so a test can simulate a service-worker restart. Storage is kept. */
export function clearVolatileState() {
  lastUsed.clear();
  sessionsByGroup.clear();
  pendingAdoptions.clear();
}

/** Pin the tab the next command in this session should use. */
export async function pinSessionTab(session, tabId) {
  if (!session?.id || tabId == null) return;
  await setLastUsed(session.id, tabId);
}

function call(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((r) => {
        const err = globalThis.chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(r);
      });
    } catch (e) { reject(e); }
  });
}

/** All groups with this session's title in this profile (any window). */
async function groupsFor(session) {
  const gs = await call((cb) => chrome.tabGroups.query({ title: groupTitle(session.name) }, cb));
  return gs || [];
}

/** Tabs currently in the session's group(s). Empty array if none. */
export async function groupTabs(session) {
  const out = [];
  for (const g of await groupsFor(session)) {
    await rememberGroupSession(g.id, session);
    const tabs = await call((cb) => chrome.tabs.query({ groupId: g.id }, cb));
    out.push(...(tabs || []));
  }
  return out;
}

async function getTab(tabId) {
  const tab = await call((cb) => chrome.tabs.get(tabId, cb));
  if (!tab) throw new Error(`tab ${tabId} does not exist in this browser profile`);
  return tab;
}

async function anyActiveTab() {
  const tabs = await call((cb) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, cb));
  if (!tabs || !tabs.length) throw new Error("no active tab in this browser profile");
  return tabs[0];
}

/** The tab a command should act on. Never returns a tab outside the session group
 *  (unless the daemon allowed anyTab). */
export async function targetTab(session, tabId, opts = {}) {
  if (opts.anyTab) {
    if (tabId !== undefined) return getTab(tabId);
    return anyActiveTab();
  }
  if (!session) throw new Error("no session — run `cohand session start <name>` and export COHAND_SESSION");
  if (pendingAdoptions.size) await Promise.allSettled([...pendingAdoptions]);
  const tabs = await groupTabs(session);
  if (!tabs.length) throw new Error(NO_TABS);
  if (tabId) {
    const hit = tabs.find((t) => t.id === tabId);
    if (!hit) throw new Error(`tab ${tabId} is not in this session's group — drag it in first`);
    await setLastUsed(session.id, hit.id);
    return hit;
  }
  const lastId = await readLastUsed(session.id);
  const last = tabs.find((t) => t.id === lastId);
  const tab = last || tabs.find((t) => t.active) || tabs[0];
  await setLastUsed(session.id, tab.id);
  return tab;
}

function groupForTarget(session, groups, tabs, tab) {
  const sameWindow = (g) => g.windowId === undefined || tab.windowId === undefined || g.windowId === tab.windowId;
  const local = groups.filter(sameWindow);
  const available = local.length ? local : groups;
  const last = tabs.find((t) => t.id === lastUsed.get(session.id));
  if (last) return available.find((g) => g.id === last.groupId) || available[0];
  const active = tabs.find((t) => t.active);
  return available.find((g) => g.id === active?.groupId) || available[0];
}

/** Move one existing tab into this session's group without changing its page state. */
export async function adoptTab(session, tabId, { anyTab = false } = {}) {
  if (!session) throw new Error("no session — run `cohand session start <name>` and export COHAND_SESSION");
  if (pendingAdoptions.size) await Promise.allSettled([...pendingAdoptions]);
  const groups = await groupsFor(session);
  const tabs = await groupTabs(session);
  const tab = anyTab ? await getTab(tabId) : tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} is not in this session's group — pass --any-tab if the user designated an outside tab`);
  await readLastUsed(session.id);
  const targetGroup = groupForTarget(session, groups, tabs, tab);
  let groupId = targetGroup?.id;
  if (groupId === undefined) {
    groupId = await call((cb) => chrome.tabs.group({ tabIds: [tab.id] }, cb));
    await rememberGroupSession(groupId, session);
    await call((cb) => chrome.tabGroups.update(groupId, { title: groupTitle(session.name), color: "cyan" }, cb));
  } else if (tab.groupId !== groupId) {
    if (targetGroup.windowId !== undefined && tab.windowId !== undefined && targetGroup.windowId !== tab.windowId) {
      await call((cb) => chrome.tabs.move(tab.id, { windowId: targetGroup.windowId, index: -1 }, cb));
    }
    await call((cb) => chrome.tabs.group({ groupId, tabIds: [tab.id] }, cb));
  } else {
    await rememberGroupSession(groupId, session);
  }
  await call((cb) => chrome.tabs.update(tab.id, { active: true }, cb));
  await setLastUsed(session.id, tab.id);
  return { tabId: tab.id, title: tab.title || "", url: tab.url || "", group: groupTitle(session.name), active: true };
}

/** Open a URL inside the session group (creating the group on first use). */
export async function openInGroup(session, url, { newTab = false } = {}) {
  if (!session) throw new Error("no session — run `cohand session start <name>` and export COHAND_SESSION");
  const tabs = await groupTabs(session);
  if (tabs.length && !newTab) {
    const t = await targetTab(session);
    await call((cb) => chrome.tabs.update(t.id, { url }, cb));
    return t.id;
  }
  const created = await call((cb) => chrome.tabs.create({ url, active: false }, cb));
  const groups = await groupsFor(session);
  const groupId = await call((cb) =>
    chrome.tabs.group(groups.length ? { groupId: groups[0].id, tabIds: [created.id] } : { tabIds: [created.id] }, cb));
  await rememberGroupSession(groupId, session);
  if (!groups.length) await call((cb) => chrome.tabGroups.update(groupId, { title: groupTitle(session.name), color: "cyan" }, cb));
  await setLastUsed(session.id, created.id);
  return created.id;
}

export function forgetSession(id) {
  lastUsed.delete(id);
  for (const [groupId, session] of sessionsByGroup) if (session.id === id) sessionsByGroup.delete(groupId);
  return Promise.all([dropStoredLastUsed(id), dropStoredSessionsForSession(id)]).then(() => {});
}

export function queueSessionChild(tab) {
  const pending = adoptSessionChild(tab).catch(() => false);
  pendingAdoptions.add(pending);
  pending.then(() => pendingAdoptions.delete(pending), () => pendingAdoptions.delete(pending));
  return pending;
}

/** Keep tabs opened by a CoHand tab inside its session group and select them next. */
export async function adoptSessionChild(tab) {
  if (!tab || tab.openerTabId === undefined) return false;
  const opener = await call((cb) => chrome.tabs.get(tab.openerTabId, cb)).catch(() => null);
  if (!opener || opener.groupId < 0) return false;
  const group = await call((cb) => chrome.tabGroups.get(opener.groupId, cb)).catch(() => null);
  if (!group || !group.title?.startsWith("🤖 ")) return false;
  const session = await getSessionForGroup(group.id);
  if (!session) return false;
  if (tab.groupId !== group.id) await call((cb) => chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] }, cb));
  await setLastUsed(session.id, tab.id);
  return true;
}

/** Update the selected tab when Chrome activates a member of a known session group.
 *  Ignore activations in a background window — those steal the tab the agent is using. */
export async function rememberActivatedTab(tabId) {
  const tab = await call((cb) => chrome.tabs.get(tabId, cb)).catch(() => null);
  if (!tab) return;
  if (typeof chrome.windows?.get === "function" && tab.windowId != null) {
    const win = await call((cb) => chrome.windows.get(tab.windowId, cb)).catch(() => null);
    if (win && win.focused === false) return;
  }
  const session = await getSessionForGroup(tab.groupId);
  if (session) await setLastUsed(session.id, tab.id);
}

/** End of session: ungroup its tabs (they stay open) and forget state. */
export async function endSession(session) {
  const tabs = await groupTabs(session);
  if (tabs.length) await call((cb) => chrome.tabs.ungroup(tabs.map((t) => t.id), cb));
  await forgetSession(session.id);
}
