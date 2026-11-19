import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { targetTab, openInGroup, groupTabs, NO_TABS, adoptTab, adoptSessionChild, queueSessionChild, rememberActivatedTab, clearVolatileState, forgetSession, getSessionForGroup } from "../extension/lib/session-tabs.js";

let state;
function fakeChrome() {
  state = { groups: [], tabs: [], nextId: 100, failGroup: false };
  const cbify = (fn) => (...a) => { const cb = a.pop(); queueMicrotask(() => cb(fn(...a))); };
  globalThis.chrome = {
    runtime: { lastError: undefined },
    tabGroups: {
      query: cbify((q) => state.groups.filter((g) => !q.title || g.title === q.title)),
      get: cbify((id) => state.groups.find((g) => g.id === id)),
      update: cbify((id, p) => { Object.assign(state.groups.find((g) => g.id === id), p); }),
    },
    tabs: {
      query: cbify((q) => state.tabs.filter((t) => (q.groupId === undefined || t.groupId === q.groupId) && (q.active === undefined || t.active === q.active))),
      get: cbify((id) => state.tabs.find((t) => t.id === id)),
      update: cbify((id, p) => Object.assign(state.tabs.find((t) => t.id === id), p)),
      move: cbify((id, p) => Object.assign(state.tabs.find((t) => t.id === id), { windowId: p.windowId, groupId: -1 })),
      create: cbify((p) => { const t = { id: state.nextId++, groupId: -1, active: false, ...p }; state.tabs.push(t); return t; }),
      group: (p, cb) => queueMicrotask(() => {
        if (state.failGroup) { chrome.runtime.lastError = { message: "tab disappeared" }; cb(); chrome.runtime.lastError = undefined; return; }
        let gid = p.groupId;
        if (gid === undefined) { gid = state.nextId++; state.groups.push({ id: gid, title: "" }); }
        for (const id of p.tabIds) state.tabs.find((t) => t.id === id).groupId = gid;
        cb(gid);
      }),
    },
  };
}
beforeEach(fakeChrome);

/** chrome.storage.session that survives clearVolatileState(), like the real one. */
function installSessionStorage() {
  const store = {};
  chrome.storage = {
    session: {
      get(key, cb) { cb({ [key]: store[key] }); },
      set(items, cb) { Object.assign(store, items); cb(); },
    },
  };
  return store;
}

const S = { id: "s1", name: "a" };

test("targetTab returns only the grouped tab, never the user's active tab", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 1, groupId: -1, active: true }, { id: 2, groupId: 1, active: false });
  assert.equal((await targetTab(S)).id, 2);
});

test("empty / missing group gives the exact error and no fallback", async () => {
  state.tabs.push({ id: 1, groupId: -1, active: true });
  await assert.rejects(targetTab(S), (e) => e.message === NO_TABS);
  state.groups.push({ id: 1, title: "🤖 a" });
  await assert.rejects(targetTab(S), (e) => e.message === "no tabs in session group — drag a tab in or cohand open");
});

test("tab outside group is refused by id", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 1, groupId: -1, active: true }, { id: 2, groupId: 1 });
  await assert.rejects(targetTab(S, 1), /not in this session's group/);
});

test("openInGroup creates group on first open, then reuses it", async () => {
  const id = await openInGroup(S, "https://a.com/");
  assert.equal(state.groups[0].title, "🤖 a");
  assert.equal(state.tabs.find((t) => t.id === id).groupId, state.groups[0].id);
  await openInGroup(S, "https://b.com/");
  assert.equal(state.groups.length, 1);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].url, "https://b.com/");
});

test("a new tab opened by a session tab joins and retargets before the next command", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true });
  await groupTabs(S);
  const child = { id: 11, groupId: -1, openerTabId: 10 };
  state.tabs.push(child);
  await queueSessionChild(child);
  assert.equal(child.groupId, 1);
  assert.equal((await targetTab(S)).id, 11);
});

test("a new tab from an unrelated tab stays outside a session group", async () => {
  state.groups.push({ id: 1, title: "Work" });
  state.tabs.push({ id: 10, groupId: 1, active: true });
  const child = { id: 11, groupId: -1, openerTabId: 10 };
  state.tabs.push(child);
  await adoptSessionChild(child);
  assert.equal(child.groupId, -1);
});

test("an unknown robot-named group is not adopted", async () => {
  state.groups.push({ id: 91, title: "🤖 other-agent" });
  state.tabs.push({ id: 10, groupId: 91, active: true });
  const child = { id: 11, groupId: -1, openerTabId: 10 };
  state.tabs.push(child);
  assert.equal(await adoptSessionChild(child), false);
  assert.equal(child.groupId, -1);
});

test("failed child adoption does not block the next session command", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true });
  await groupTabs(S);
  const child = { id: 11, groupId: -1, openerTabId: 10 };
  state.tabs.push(child);
  state.failGroup = true;
  assert.equal(await queueSessionChild(child), false);
  state.failGroup = false;
  assert.equal((await targetTab(S)).id, 10);
});

test("activating a session tab retargets the next command to it", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1 }, { id: 11, groupId: 1 });
  await groupTabs(S);
  await targetTab(S, 10);
  await rememberActivatedTab(11);
  assert.equal((await targetTab(S)).id, 11);
});

test("targetTab survives a service-worker restart via chrome.storage.session", async () => {
  const store = {};
  chrome.storage = {
    session: {
      get(key, cb) { cb({ [key]: store[key] }); },
      set(items, cb) { Object.assign(store, items); cb(); },
    },
  };
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true }, { id: 11, groupId: 1, active: false });
  await targetTab(S, 11);
  clearVolatileState();
  assert.equal((await targetTab(S)).id, 11);
});

test("cold start: activating a sibling in a stored session group retargets the next command", async () => {
  clearVolatileState();
  const store = installSessionStorage();
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true }, { id: 11, groupId: 1, active: false });
  await targetTab(S, 10);
  assert.deepEqual(store.cohandSessionsByGroup["1"], { id: "s1", name: "a" });
  clearVolatileState();
  await rememberActivatedTab(11);
  assert.equal(store.cohandLastUsed.s1, 11);
  assert.equal((await targetTab(S)).id, 11);
});

test("cold start: a child of a stored session tab joins the group and is selected next", async () => {
  clearVolatileState();
  const store = installSessionStorage();
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true });
  await groupTabs(S);
  clearVolatileState();
  const groupCalls = [];
  const group = chrome.tabs.group;
  chrome.tabs.group = (p, cb) => { groupCalls.push(p); group(p, cb); };
  const child = { id: 12, groupId: -1, openerTabId: 10 };
  state.tabs.push(child);
  assert.equal(await adoptSessionChild(child), true);
  assert.deepEqual(groupCalls, [{ groupId: 1, tabIds: [12] }]);
  assert.equal(child.groupId, 1);
  assert.equal(store.cohandLastUsed.s1, 12);
  assert.equal((await targetTab(S)).id, 12);
});

test("cold start: activating a tab in an unrelated group changes nothing", async () => {
  clearVolatileState();
  const store = installSessionStorage();
  state.groups.push({ id: 1, title: "🤖 a" }, { id: 2, title: "Work" });
  state.tabs.push({ id: 10, groupId: 1, active: true }, { id: 20, groupId: 2, active: false });
  await targetTab(S, 10);
  clearVolatileState();
  await rememberActivatedTab(20);
  assert.equal(store.cohandLastUsed.s1, 10);
  assert.equal(store.cohandSessionsByGroup["2"], undefined);
  assert.equal((await targetTab(S)).id, 10);
});

test("forgetSession removes the stored group mapping", async () => {
  clearVolatileState();
  const store = installSessionStorage();
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true });
  await groupTabs(S);
  assert.deepEqual(store.cohandSessionsByGroup["1"], { id: "s1", name: "a" });
  await forgetSession(S.id);
  assert.equal(store.cohandSessionsByGroup["1"], undefined);
  assert.equal(await getSessionForGroup(1), undefined);
});

test("a failing session storage keeps group tracking working in memory", async () => {
  clearVolatileState();
  chrome.storage = {
    session: {
      get() { throw new Error("storage unavailable"); },
      set() { throw new Error("storage unavailable"); },
    },
  };
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, active: true }, { id: 11, groupId: 1, active: false });
  await groupTabs(S);
  await rememberActivatedTab(11);
  assert.equal((await targetTab(S)).id, 11);
});

test("rememberActivatedTab on a tab in an unfocused window does not steal the selected tab", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 10, groupId: 1, windowId: 1 }, { id: 11, groupId: 1, windowId: 2 });
  chrome.windows = {
    get(id, cb) { cb({ id, focused: id !== 2 }); },
  };
  await groupTabs(S);
  await targetTab(S, 10);
  await rememberActivatedTab(11);
  assert.equal((await targetTab(S)).id, 10);
});

test("anyTab escape hatch uses the active tab", async () => {
  state.tabs.push({ id: 7, groupId: -1, active: true });
  assert.equal((await targetTab(S, undefined, { anyTab: true })).id, 7);
});

test("adopt moves one existing tab into the session group and retargets it", async () => {
  const session = { id: "adopt-1", name: "adopter" };
  state.groups.push({ id: 4, title: "🤖 adopter" });
  const handed = { id: 22, groupId: -1, active: false, url: "https://business.google.com/locations#selected", formState: "preserved" };
  state.tabs.push(handed, { id: 23, groupId: 4, active: false });
  const result = await adoptTab(session, 22, { anyTab: true });
  assert.equal(result.tabId, 22);
  assert.equal(handed.groupId, 4);
  assert.equal(handed.url, "https://business.google.com/locations#selected");
  assert.equal(handed.formState, "preserved");
  assert.equal(handed.active, true);
  assert.equal((await targetTab(session)).id, 22);
});

test("adopt is idempotent and refuses an outside tab without anyTab", async () => {
  const session = { id: "adopt-2", name: "adopter-2" };
  state.groups.push({ id: 5, title: "🤖 adopter-2" });
  state.tabs.push({ id: 24, groupId: 5, active: false }, { id: 25, groupId: -1, active: false });
  await adoptTab(session, 24);
  assert.equal((await targetTab(session)).id, 24);
  await assert.rejects(adoptTab(session, 25), /not in this session's group/);
  await assert.rejects(adoptTab(session, 999, { anyTab: true }), /does not exist/);
});

test("adopt moves a cross-window tab into the existing group without duplicating it", async () => {
  const session = { id: "adopt-window", name: "window-adopter" };
  state.groups.push({ id: 6, title: "🤖 window-adopter", windowId: 1 });
  const handed = { id: 27, groupId: -1, windowId: 2, active: false, url: "https://example.test/window" };
  state.tabs.push(handed, { id: 28, groupId: 6, windowId: 1, active: false });
  await adoptTab(session, 27, { anyTab: true });
  assert.equal(state.groups.length, 1);
  assert.equal(handed.groupId, 6);
  assert.equal(handed.windowId, 1);
  assert.equal(handed.url, "https://example.test/window");
});

test("adopt creates the session group without opening or reloading the tab", async () => {
  const session = { id: "adopt-3", name: "empty-adopter" };
  const handed = { id: 26, groupId: -1, active: false, url: "https://example.test/form" };
  state.tabs.push(handed);
  await adoptTab(session, 26, { anyTab: true });
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].title, "🤖 empty-adopter");
  assert.equal(state.tabs.length, 1);
  assert.equal(handed.url, "https://example.test/form");
});

import { typeFlow, parseCombo } from "../extension/lib/cdp.js";

test("typeFlow: DOM typing that sticks does not use CDP", async () => {
  let cdp = 0, v = "";
  const r = await typeFlow({ domType: async (t) => { v = t; return { stuck: true }; }, readBack: async () => v, prepareReal: async () => {}, insert: async () => { cdp++; } }, "hi");
  assert.equal(r.method, "dom");
  assert.equal(cdp, 0);
});

test("typeFlow: controlled input reverts -> automatic CDP insertText retry", async () => {
  let v = "";
  const r = await typeFlow({
    domType: async () => { v = ""; return { stuck: false }; },
    readBack: async () => v,
    prepareReal: async () => { v = ""; },
    insert: async (t) => { v = t; },
  }, "hello");
  assert.equal(r.method, "cdp");
  assert.equal(v, "hello");
});

test("typeFlow: --real skips DOM typing; failure after CDP throws", async () => {
  let dom = 0;
  await assert.rejects(typeFlow({ domType: async () => { dom++; }, readBack: async () => "", prepareReal: async () => {}, insert: async () => {} }, "x", true), /did not stick/);
  assert.equal(dom, 0);
});

test("parseCombo", () => {
  assert.equal(parseCombo("Enter").windowsVirtualKeyCode, 13);
  assert.equal(parseCombo("Ctrl+A").modifiers, 2);
  assert.equal(parseCombo("Ctrl+Shift+a").modifiers, 10);
  assert.throws(() => parseCombo("Hyper+A"), /unknown modifier/);
});

test("endSession ungroups the session's tabs and never closes them", async () => {
  const { endSession } = await import("../extension/lib/session-tabs.js");
  chrome.tabs.ungroup = (ids, cb) => { for (const id of [].concat(ids)) state.tabs.find((t) => t.id === id).groupId = -1; cb(); };
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 5, groupId: 1 }, { id: 6, groupId: 1 }, { id: 7, groupId: -1 });
  await endSession(S);
  assert.equal(state.tabs.length, 3);
  assert.deepEqual(state.tabs.map((t) => t.groupId), [-1, -1, -1]);
});

test("open brings its tab to the front when the user is watching the agent's group", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 2, groupId: 1, active: true });
  const id = await openInGroup(S, "https://b.com/", { newTab: true });
  assert.equal(state.tabs.find((t) => t.id === id).active, true);
});

test("open never steals focus from the user's own tab", async () => {
  state.groups.push({ id: 1, title: "🤖 a" });
  state.tabs.push({ id: 1, groupId: -1, active: true }, { id: 2, groupId: 1, active: false });
  const id = await openInGroup(S, "https://b.com/", { newTab: true });
  assert.equal(state.tabs.find((t) => t.id === id).active, false);
  assert.equal(state.tabs.find((t) => t.id === 1).active, true);
});
