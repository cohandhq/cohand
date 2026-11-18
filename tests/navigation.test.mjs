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
