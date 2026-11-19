import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadPolicy, check, defaultPolicy, matches, BUILTIN_BLOCK } from "../daemon/policy.mjs";
import { appendLog, redact, readLog } from "../daemon/log.mjs";
import { startDaemon } from "../daemon/server.mjs";
import { tmpHome, client, host } from "./helpers.mjs";

test("default block list matches subdomains", () => {
  const p = defaultPolicy();
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://www.paypal.com/x" }).verdict, "deny");
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://login.paypal.com/" }).verdict, "deny");
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://stripe.com/dashboard/x" }).verdict, "deny");
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://stripe.com/docs" }).verdict, "allow");
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://example.com/" }).verdict, "allow");
  assert.ok(matches("accounts.google.com/*security*", "https://accounts.google.com/signin/security/x"));
});

test("allow list overrides default block only when listed", () => {
  const p = defaultPolicy();
  p.profiles.w = { allow: ["paypal.com"] };
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://paypal.com/" }).verdict, "allow");
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://1password.com/" }).verdict, "deny");
  assert.equal(check(p, { profile: "other", op: "snapshot", url: "https://paypal.com/" }).verdict, "deny");
});

test("default policy blocks bare and www bank hosts", () => {
  const p = defaultPolicy();
  const hosts = [
    "bankofamerica.com", "www.bankofamerica.com", "usbank.com", "www.usbank.com",
    "chase.com", "www.chase.com", "citi.com", "wellsfargo.com", "capitalone.com",
    "barclays.co.uk", "commbank.com.au", "login.example.bank",
  ];
  for (const h of hosts) {
    assert.equal(check(p, { profile: "w", op: "snapshot", url: `https://${h}/` }).verdict, "deny", h);
  }
  assert.ok(BUILTIN_BLOCK.includes("*.bank"));
  assert.ok(!BUILTIN_BLOCK.includes("*.bank*"), "the broad *.bank* wildcard must be gone");
});

test("bank rules do not sweep in lookalike domains", () => {
  const p = defaultPolicy();
  for (const h of ["evil.bankruptcy.com", "bankruptcy.com", "notabank.example"]) {
    assert.equal(check(p, { profile: "w", op: "snapshot", url: `https://${h}/` }).verdict, "allow", h);
  }
  assert.equal(matches("*.bank", "https://evil.bankruptcy.com/"), false);
});

test("path patterns still match host+path by prefix", () => {
  assert.equal(matches("stripe.com/dashboard", "https://stripe.com/dashboard/x"), true);
  assert.equal(matches("stripe.com/dashboard", "https://stripe.com/docs"), false);
  assert.equal(matches("example.com/admin", "https://a.example.com/admin/users"), true);
  assert.equal(matches("example.com/admin", "https://example.com/administrator"),
    true, "prefix semantics are unchanged");
});

test("matches() is case-insensitive so hand-edited patterns block", () => {
  assert.equal(matches("PayPal.com", "https://paypal.com/"), true);
  assert.equal(matches("PAYPAL.COM", "https://login.paypal.com/"), true);
  assert.equal(matches("Stripe.com/Dashboard", "https://stripe.com/dashboard/x"), true);
  assert.equal(matches("paypal.com", "https://PayPal.com/"), true);
  assert.equal(matches("PayPal.com", "not a url"), false);

  const p = defaultPolicy();
  p.profiles.w = { block: ["PayPal.com"] };
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://paypal.com/" }).verdict, "deny");
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://www.paypal.com/x" }).verdict, "deny");
});

test("allow list overrides the default bank block", () => {
  const p = defaultPolicy();
  p.profiles.w = { allow: ["Chase.com"] };
  assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://chase.com/" }).verdict, "allow");
  assert.equal(check(p, { profile: "other", op: "snapshot", url: "https://chase.com/" }).verdict, "deny");
});

test("legacy *.bank* entry is migrated to the explicit list on load", () => {
  const home = tmpHome();
  const file = path.join(home, "policy.json");
  fs.writeFileSync(file, JSON.stringify({
    off: false, profiles: {},
    defaults: { block: ["*.bank*", "paypal.com", "custom.example"], askFirst: false },
  }));
  const p = loadPolicy(file);
  assert.ok(!p.defaults.block.includes("*.bank*"));
  assert.ok(p.defaults.block.includes("bankofamerica.com"));
  assert.ok(p.defaults.block.includes("paypal.com"));
  assert.ok(p.defaults.block.includes("custom.example"), "custom entries are kept");
  assert.equal(new Set(p.defaults.block).size, p.defaults.block.length, "no duplicates");

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(!onDisk.defaults.block.includes("*.bank*"), "migration is persisted");
  assert.equal(onDisk.defaults.block.filter((x) => x === "paypal.com").length, 1);
});

test("eval asks; click risky false allows; risky true asks", () => {
  const fresh = defaultPolicy();
  assert.equal(check(fresh, { profile: "w", op: "eval", url: "https://a.com/" }).verdict, "allow");
  assert.equal(check(fresh, { profile: "w", op: "click", url: "https://a.com/", args: { risky: true } }).verdict, "allow");
  const p = defaultPolicy();
  p.defaults.askFirst = true;
  assert.equal(check(p, { profile: "w", op: "eval", url: "https://a.com/" }).verdict, "ask");
  assert.equal(check(p, { profile: "w", op: "click", url: "https://a.com/", args: { risky: false } }).verdict, "allow");
  assert.equal(check(p, { profile: "w", op: "click", url: "https://a.com/", args: { risky: true } }).verdict, "ask");
  p.profiles.w = { askFirst: false };
  assert.equal(check(p, { profile: "w", op: "eval", url: "https://a.com/" }).verdict, "allow");
});

test("off denies with message", () => {
  const p = defaultPolicy();
  p.profiles.w = { off: true };
  const r = check(p, { profile: "w", op: "snapshot" });
  assert.equal(r.verdict, "deny");
  assert.match(r.reason, /switched off for w/);
  p.off = true;
  assert.match(check(p, { profile: "x", op: "snapshot" }).reason, /switched off/);
});

test("loadPolicy creates default file; log redacts typed text", () => {
  const home = tmpHome();
  const f = path.join(home, "policy.json");
  loadPolicy(f);
  assert.ok(fs.existsSync(f));
  const dir = path.join(home, "log");
  appendLog(dir, { op: "type", args: redact("type", { ref: "e1", text: "hello" }) });
  const [e] = readLog(dir);
  assert.deepEqual(e.args.text, { len: 5 });
  assert.ok(!fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8").includes("hello"));
});

test("daemon: outside-tab adoption requires the existing any-tab policy", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const seen = [];
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    seen.push(m.cmd);
    hh.send({ type: "result", id: m.id, ok: true, data: { url: "https://example.test/", risky: false } });
  });
  const c = await client(d.sock);
  const s = (await c.request("session.start", { name: "guarded" })).data.session;
  const r = await c.request("adopt", { tabId: 42, anyTab: true }, { session: s });
  assert.equal(r.ok, false);
  assert.match(r.error, /--any-tab is not allowed/);
  assert.deepEqual(seen, [], "denied adoption must not inspect the outside tab");
  h.close(); c.close(); await d.close();
});

test("daemon: text reads cannot include a policy-blocked nested frame", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const seen = [];
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    seen.push(m.cmd);
    hh.send({ type: "result", id: m.id, ok: true, data: {
      url: "https://accounts.google.com/profile", topUrl: "https://accounts.google.com/profile",
      frameUrls: ["https://accounts.google.com/signin/security/check"], risky: false,
    } });
  });
  const c = await client(d.sock);
  try {
    const result = await c.request("text");
    assert.equal(result.ok, false);
    assert.match(result.error, /blocked/);
    assert.deepEqual(seen, ["inspect"]);
  } finally { h.close(); c.close(); await d.close(); }
});

test("daemon: ask timeout denies and logs denied:timeout; off blocks", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home, askTimeoutMs: 50 });
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    if (m.cmd === "inspect") hh.send({ type: "result", id: m.id, ok: true, data: { url: "https://a.com/", risky: false } });
    else if (m.cmd === "ask") { /* never answer */ }
    else hh.send({ type: "result", id: m.id, ok: true, data: { ran: m.cmd } });
  });
  const c = await client(d.sock);
  const allowed = await c.request("eval", { js: "1" });
  assert.equal(allowed.ok, true);
  const policyFile = path.join(home, "policy.json");
  const pol = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  pol.defaults.askFirst = true;
  fs.writeFileSync(policyFile, JSON.stringify(pol, null, 2) + "\n");
  const r = await c.request("eval", { js: "1" });
  assert.equal(r.ok, false);
  assert.match(r.error, /denied/);
  assert.equal(readLog(path.join(home, "log")).at(-1).denied, "timeout");
  assert.equal((await c.request("snapshot")).data.ran, "snapshot");
  await c.request("off", {}, { profile: "work" });
  const off = await c.request("snapshot");
  assert.match(off.error, /switched off for work/);
  await c.request("on", {}, { profile: "work" });
  assert.equal((await c.request("snapshot")).ok, true);
  h.close(); c.close(); await d.close();
});

test("setBlock adds and removes a domain in a profile's block list", async () => {
  const { setBlock } = await import("../daemon/policy.mjs");
  const p = defaultPolicy();
  setBlock(p, "work", "Example.com", true);
  setBlock(p, "work", "example.com", true);
  assert.deepEqual(p.profiles.work.block, ["example.com"]);
  assert.equal(check(p, { profile: "work", op: "snapshot", url: "https://a.example.com/" }).verdict, "deny");
  assert.equal(check(p, { profile: "other", op: "snapshot", url: "https://example.com/" }).verdict, "allow");
  setBlock(p, "work", "example.com", false);
  assert.deepEqual(p.profiles.work.block, []);
  assert.throws(() => setBlock(p, "work", "bad domain/x", true), /invalid domain/);
});

test("a corrupt policy.json falls back to defaults and is left untouched for repair", () => {
  const home = tmpHome();
  const file = path.join(home, "policy.json");
  fs.writeFileSync(file, "{ not json");
  const err = console.error; console.error = () => {};
  try {
    const p = loadPolicy(file);
    assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://www.paypal.com/x" }).verdict, "deny", "built-in blocks stay on");
    assert.equal(check(p, { profile: "w", op: "snapshot", url: "https://example.com" }).verdict, "allow");
  } finally { console.error = err; }
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "file not overwritten");
});

test("daemon: a failed log write does not turn a completed action into an error", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    if (m.cmd === "inspect") hh.send({ type: "result", id: m.id, ok: true, data: { url: "https://a.com/", risky: false } });
    else hh.send({ type: "result", id: m.id, ok: true, data: { ran: m.cmd } });
  });
  const c = await client(d.sock);
  const logDir = path.join(home, "log");
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.writeFileSync(logDir, "not a directory"); // every log write now fails
  const err = console.error; console.error = () => {};
  try {
    const r = await c.request("snapshot");
    assert.equal(r.ok, true);
    assert.equal(r.data.ran, "snapshot");
  } finally { console.error = err; }
  h.close(); c.close(); await d.close();
});
