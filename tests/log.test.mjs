import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { redact, redactUrl, redactError } from "../daemon/log.mjs";
import { startDaemon } from "../daemon/server.mjs";
import { tmpHome, host, client } from "./helpers.mjs";

test("redact hides typed text and eval source, keeping only length", () => {
  const out = redact("type", { ref: "e1", text: "hunter2" });
  assert.deepEqual(out, { ref: "e1", text: { len: 7 } });
  const js = redact("eval", { js: "document.cookie", awaitPromise: true });
  assert.deepEqual(js, { js: { len: 15 }, awaitPromise: true });
  assert.ok(!JSON.stringify(js).includes("document.cookie"));
});

test("redact strips query and fragment from url fields, keeping origin and path", () => {
  const out = redact("open", { url: "https://accounts.test/oauth/callback?code=SECRET&state=x#frag", newTab: true });
  assert.equal(out.url, "https://accounts.test/oauth/callback");
  assert.equal(out.newTab, true);
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("redact strips url fields nested inside args but leaves other values untouched", () => {
  const out = redact("open", {
    url: "https://a.test/p?q=1",
    tab: { url: "https://b.test/q?token=2#h", title: "keep me" },
    list: [{ url: "https://c.test/r#x" }],
    n: 3,
    flag: false,
    none: null,
  });
  assert.equal(out.url, "https://a.test/p");
  assert.equal(out.tab.url, "https://b.test/q");
  assert.equal(out.tab.title, "keep me");
  assert.equal(out.list[0].url, "https://c.test/r");
  assert.equal(out.n, 3);
  assert.equal(out.flag, false);
  assert.equal(out.none, null);
});

test("redact leaves non-string url values untouched", () => {
  const out = redact("open", { url: 42, other: { url: { deep: "https://x.test/?a=1" } } });
  assert.equal(out.url, 42);
  assert.deepEqual(out.other.url, { deep: "https://x.test/?a=1" });
  assert.deepEqual(redact("open"), {});
});

test("redactUrl keeps origin + path and drops query and fragment", () => {
  assert.equal(redactUrl("https://example.test/a/b?token=abc#frag"), "https://example.test/a/b");
  assert.equal(redactUrl("http://localhost:3000/x?y=1"), "http://localhost:3000/x");
  assert.equal(redactUrl("https://example.test?token=abc"), "https://example.test/");
  assert.equal(redactUrl("https://example.test/a/b"), "https://example.test/a/b");
});

test("redactUrl tolerates invalid and relative URLs", () => {
  assert.equal(redactUrl("/local/path?x=1#y"), "/local/path");
  assert.equal(redactUrl("not a url?q=1"), "not a url");
  assert.equal(redactUrl("not a url"), "not a url");
  assert.equal(redactUrl(""), "");
  assert.equal(redactUrl("?only=query"), "");
});

test("redactError caps long messages at 200 chars", () => {
  const msg = "x".repeat(500);
  const out = redactError(msg);
  assert.equal(out.length, 200);
  assert.ok(out.startsWith("x".repeat(100)));
  assert.equal(redactError("short failure"), "short failure");
});

test("redactError strips query strings from embedded URLs", () => {
  const out = redactError("open failed: https://auth.test/cb?code=SECRET&state=1#frag (timeout)");
  assert.equal(out, "open failed: https://auth.test/cb (timeout)");
  assert.ok(!out.includes("SECRET"));
  const long = redactError("e ".repeat(5) + "https://a.test/x?token=SECRET " + "y".repeat(300));
  assert.ok(!long.includes("SECRET"));
  assert.equal(long.length, 200);
});

test("gate logs redacted urls and errors but still enforces on the full url", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const seen = [];
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    seen.push({ cmd: m.cmd, args: m.args });
    if (m.cmd === "inspect") {
      return hh.send({ type: "result", id: m.id, ok: true, data: { url: "https://app.test/page?token=SECRET3", risky: false } });
    }
    if (m.cmd === "open") {
      return hh.send({ type: "result", id: m.id, ok: true, data: { url: "https://accounts.test/cb?code=SECRET", tabId: 1 } });
    }
    hh.send({ type: "result", id: m.id, ok: false, error: "eval failed: https://api.test/x?token=SECRET2" });
  });
  const c = await client(d.sock);
  try {
    await c.request("open", { url: "https://accounts.test/login?code=SECRET#frag" }, { profile: "work" });
    await c.request("eval", { js: "document.cookie" }, { profile: "work" });
  } finally {
    h.close();
    c.close();
    await d.close();
  }

  const raw = fs.readdirSync(path.join(home, "log"))
    .map((f) => fs.readFileSync(path.join(home, "log", f), "utf8")).join("");
  assert.ok(!raw.includes("SECRET"), raw);
  assert.ok(!raw.includes("document.cookie"), raw);

  const entries = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const open = entries.find((e) => e.op === "open");
  assert.equal(open.url, "https://accounts.test/login");
  assert.equal(open.args.url, "https://accounts.test/login");
  assert.deepEqual(open.args, { url: "https://accounts.test/login" });

  const evald = entries.find((e) => e.op === "eval" && e.result === "error");
  assert.equal(evald.url, "https://app.test/page");
  assert.deepEqual(evald.args.js, { len: 15 });
  assert.equal(evald.error, "eval failed: https://api.test/x");

  // policy still saw the full URL (it reaches the host untouched)
  assert.equal(seen.find((s) => s.cmd === "open").args.url, "https://accounts.test/login?code=SECRET#frag");
});
