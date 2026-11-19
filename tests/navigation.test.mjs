import { test } from "node:test";
import assert from "node:assert/strict";
import { historyError, watchTabChange } from "../extension/lib/navigation.js";

test("back history errors explain that no previous page exists", () => {
  assert.equal(historyError("back", new Error("Cannot find a next page in history")), "no previous page in history");
});

test("forward history errors explain that no next page exists", () => {
  assert.equal(historyError("forward", new Error("Cannot find a previous page in history")), "no next page in history");
});

test("unrelated navigation errors are preserved", () => {
  assert.equal(historyError("back", new Error("tab closed")), "tab closed");
});

test("click result waits for the new page title after its navigation events", async () => {
  const listeners = new Set();
  const onUpdated = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  const tab = { id: 7, url: "http://localhost/", title: "Old title" };
  const changed = watchTabChange(7, { ...tab }, { onUpdated, getTab: async () => ({ ...tab }) }, 1000);
  for (const listener of listeners) listener(7, { status: "loading" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  tab.url = "http://localhost/next";
  tab.title = "Fresh title";
  for (const listener of listeners) listener(7, { status: "complete", url: tab.url, title: tab.title });
  const result = await changed;
  assert.equal(result.title, "Fresh title");
  assert.equal(result.url, "http://localhost/next");
});

test("navigation settling waits past the idle window once a page starts loading", async () => {
  const listeners = new Set();
  const onUpdated = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  const tab = { id: 8, url: "http://localhost/", title: "Old" };
  let settled = false;
  const changed = watchTabChange(8, { ...tab }, { onUpdated, getTab: async () => ({ ...tab }) }, 20, 500)
    .then((result) => { settled = true; return result; });
  for (const listener of listeners) listener(8, { status: "loading" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  tab.url = "http://localhost/new";
  tab.title = "New";
  for (const listener of listeners) listener(8, { status: "complete", url: tab.url, title: tab.title });
  assert.equal((await changed).title, "New");
});

test("no navigation events resolves after the idle window with navigated:false", async () => {
  const listeners = new Set();
  const onUpdated = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  const tab = { id: 9, url: "http://localhost/", title: "Same" };
  const started = Date.now();
  const result = await watchTabChange(9, { ...tab }, { onUpdated, getTab: async () => ({ ...tab }) }, 40);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 30, `resolved too early (${elapsed} ms)`);
  assert.equal(result.navigated, false);
  assert.equal(result.loading, false);
  assert.equal(result.title, "Same");
  assert.equal(listeners.size, 0, "listener is removed");
});

test("a committed navigation resolves quickly without waiting for complete", async () => {
  const listeners = new Set();
  const onUpdated = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  const tab = { id: 10, url: "http://localhost/", title: "Old" };
  const started = Date.now();
  const changed = watchTabChange(10, { ...tab }, { onUpdated, getTab: async () => ({ ...tab }) });
  for (const listener of listeners) listener(10, { status: "loading" });
  tab.url = "http://localhost/slow";
  for (const listener of listeners) listener(10, { status: "loading", url: tab.url });
  const result = await changed;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `should not wait for complete (${elapsed} ms)`);
  assert.equal(result.navigated, true);
  assert.equal(result.loading, true);
  assert.equal(result.url, "http://localhost/slow");
});

test("a navigation that starts after 500 ms is still detected", async () => {
  const listeners = new Set();
  const onUpdated = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  const tab = { id: 11, url: "http://localhost/", title: "Old" };
  let settled = false;
  const changed = watchTabChange(11, { ...tab }, { onUpdated, getTab: async () => ({ ...tab }) })
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(settled, false, "the idle window must still be open at 500 ms");
  tab.url = "http://localhost/late";
  for (const listener of listeners) listener(11, { status: "loading", url: tab.url });
  const result = await changed;
  assert.equal(result.navigated, true);
  assert.equal(result.url, "http://localhost/late");
});

test("a page that keeps loading resolves at the settle cap", async () => {
  const listeners = new Set();
  const onUpdated = { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) };
  const tab = { id: 12, url: "http://localhost/", title: "Old" };
  const started = Date.now();
  const changed = watchTabChange(12, { ...tab }, { onUpdated, getTab: async () => ({ ...tab }) }, 800, 50);
  for (const listener of listeners) listener(12, { status: "loading" });
  const result = await changed;
  assert.ok(Date.now() - started < 500, "settle cap should end the wait");
  assert.equal(result.navigated, true);
  assert.equal(result.loading, true);
});
