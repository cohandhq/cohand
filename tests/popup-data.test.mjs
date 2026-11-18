import { test } from "node:test";
import assert from "node:assert/strict";
import { timeAgo, domainOf, isBlocked, statusView, shapeRecent } from "../extension/lib/popup-data.js";

const NOW = Date.parse("2026-10-20T10:00:00Z");

test("timeAgo is short and human", () => {
  assert.equal(timeAgo("2026-10-20T09:59:58Z", NOW), "just now");
  assert.equal(timeAgo("2026-10-20T09:59:00Z", NOW), "1m ago");
  assert.equal(timeAgo("2026-10-20T07:00:00Z", NOW), "3h ago");
  assert.equal(timeAgo(null, NOW), "");
});

test("domainOf only for http(s) pages", () => {
  assert.equal(domainOf("https://www.Example.com/a?b"), "www.example.com");
  assert.equal(domainOf("chrome://extensions"), null);
  assert.equal(domainOf("nonsense"), null);
});

test("isBlocked matches the domain or a parent entry", () => {
  assert.equal(isBlocked("example.com", ["example.com"]), true);
  assert.equal(isBlocked("a.example.com", ["example.com"]), true);
  assert.equal(isBlocked("example.com", ["a.example.com"]), false);
  assert.equal(isBlocked("x.com", undefined), false);
});

test("statusView: label + dot from front / enabled / connected", () => {
  assert.deepEqual(statusView({ enabled: true, connected: true, front: true }), { label: "Active", dot: "on" });
  assert.deepEqual(statusView({ enabled: true, connected: true, front: false }), { label: "Standby", dot: "standby" });
  assert.deepEqual(statusView({ enabled: false, connected: false, front: false }), { label: "Paused", dot: "off" });
  assert.deepEqual(statusView({ enabled: true, connected: false, front: false }), { label: "Connecting…", dot: "standby" });
});

test("shapeRecent: newest first, max 20, ok/denied/error", () => {
  const raw = Array.from({ length: 25 }, (_, i) => ({ t: `2026-10-20T09:00:${String(i).padStart(2, "0")}Z`, session: "s", op: "click", result: i === 24 ? "denied" : i === 23 ? "error" : "ok" }));
  const out = shapeRecent(raw, NOW);
  assert.equal(out.length, 20);
  assert.equal(out[0].status, "denied");
  assert.equal(out[1].status, "error");
  assert.equal(out[2].status, "ok");
  assert.equal(out[0].action, "click");
});
