import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TOOLS, getTool, validateArgs, saveScreenshot, screenshotDir } = require("../adapters/pi/tools.mjs");

// 1x1 transparent PNG as a data URL
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// fake cohandd client: request(op, args, extra) -> data
const fakeBridge = (behavior) => ({
  request: async (op, args, extra) => (op === "profiles" ? ["p1", "p2"] : behavior(extra?.profile, op, args)),
});

test("tool set is complete", () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "browser_activate", "browser_click", "browser_close", "browser_cookies", "browser_downloads",
    "browser_get_text", "browser_open", "browser_press", "browser_screenshot", "browser_scroll",
    "browser_select", "browser_snapshot", "browser_status", "browser_tabs", "browser_type",
    "browser_wait_for",
  ].sort());
  for (const t of TOOLS) {
    assert.equal(typeof t.description, "string");
    assert.match(t.description, /\S/);
    assert.equal(typeof t.run, "function");
  }
});

test("every tool accepts optional profile", async () => {
  const b = fakeBridge(() => ({}));
  for (const t of TOOLS) {
    if (t.name === "browser_status") continue;
    const has = t.args.some((a) => a.name === "profile" && !a.required);
    assert.ok(has, `${t.name} must declare optional profile arg`);
  }
});

test("validateArgs: missing required arg", () => {
  assert.throws(() => validateArgs("browser_open", {}), /url/);
  assert.throws(() => validateArgs("browser_click", {}), /ref/);
});

test("validateArgs: rejects unknown args", () => {
  assert.throws(() => validateArgs("browser_open", { url: "https://x.test", bogus: 1 }), /unknown/i);
});

test("validateArgs: browser_open requires http(s) url", () => {
  assert.throws(() => validateArgs("browser_open", { url: "file:///etc/passwd" }), /http/i);
  assert.throws(() => validateArgs("browser_open", { url: "javascript:alert(1)" }), /http/i);
  validateArgs("browser_open", { url: "https://x.test" }); // ok
  validateArgs("browser_open", { url: "http://localhost:3000" }); // ok
});

test("validateArgs: enum args", () => {
  assert.throws(() => validateArgs("browser_scroll", { direction: "sideways" }), /direction/i);
  validateArgs("browser_scroll", { direction: "down" });
  assert.throws(() => validateArgs("browser_wait_for", {}), /text|selector/i);
});

test("validateArgs: wrong types", () => {
  assert.throws(() => validateArgs("browser_activate", { tabId: "seven" }), /tabId/i);
  validateArgs("browser_activate", { tabId: 7 });
});

test("browser_status reports bridge state without sending", async () => {
  const t = getTool("browser_status");
  const out = await t.run({ request: async (op) => { if (op !== "profiles") throw new Error("should only ask profiles"); return []; } }, {});
  assert.match(out.content, /no browser profiles connected/i);
  const out2 = await t.run(fakeBridge(() => ({})), {});
  assert.match(out2.content, /p1/);
});

test("browser_open routes url and group to bridge", async () => {
  const calls = [];
  const b = fakeBridge((p, op, args) => { calls.push({ p, op, args }); return { tabId: 1 }; });
  const t = getTool("browser_open");
  const out = await t.run(b, { url: "https://example.com", profile: "p2" });
  assert.match(out.content, /example\.com/);
  assert.deepEqual(calls[0], { p: "p2", op: "open", args: { url: "https://example.com", newTab: false } });
});

test("connection errors surface connected profiles", async () => {
  const b = { request: async () => { throw new Error("profile alpha is not connected (connected profiles: alpha)"); } };
  const t = getTool("browser_click");
  await assert.rejects(t.run(b, { ref: "e3" }), /alpha/);
});

test("browser_screenshot saves dataUrl to a file and reports the path", async () => {
  const { tmpHome } = await import("./helpers.mjs");
  const prevHome = process.env.COHAND_HOME;
  const prevTmp = process.env.COHAND_TMP;
  delete process.env.COHAND_TMP;
  process.env.COHAND_HOME = tmpHome();
  const b = fakeBridge(() => ({ dataUrl: TINY_PNG, width: 1, height: 1 }));
  const t = getTool("browser_screenshot");
  try {
    const out = await t.run(b, { fullPage: true });
    assert.match(out.content, /saved screenshot/i);
    assert.ok(out.structured?.path, "path present");
    assert.ok(fs.existsSync(out.structured.path));
    assert.ok(out.content.includes(out.structured.path));
    assert.equal(fs.statSync(out.structured.path).size > 30, true);
  } finally {
    if (prevHome === undefined) delete process.env.COHAND_HOME; else process.env.COHAND_HOME = prevHome;
    if (prevTmp !== undefined) process.env.COHAND_TMP = prevTmp;
  }
});

test("browser_screenshot writes under the private per-user tmp dir, not /tmp/cohand", async () => {
  const { tmpHome } = await import("./helpers.mjs");
  const home = tmpHome();
  const prevHome = process.env.COHAND_HOME;
  const prevTmp = process.env.COHAND_TMP;
  delete process.env.COHAND_TMP;
  process.env.COHAND_HOME = home;
  try {
    const dir = screenshotDir();
    assert.equal(dir, path.join(home, "tmp"));
    const file = saveScreenshot(TINY_PNG);
    assert.equal(path.dirname(file), dir);
    assert.ok(file.startsWith(path.join(home, "tmp") + path.sep), file);
    assert.ok(!file.startsWith("/tmp/cohand/"), file);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // the status tool advertises the same private dir
    const st = await getTool("browser_status").run(fakeBridge(() => ({})), {});
    assert.ok(st.content.includes(dir), st.content);
  } finally {
    if (prevHome === undefined) delete process.env.COHAND_HOME; else process.env.COHAND_HOME = prevHome;
    if (prevTmp === undefined) delete process.env.COHAND_TMP; else process.env.COHAND_TMP = prevTmp;
  }
});

test("browser_screenshot rejects non-image data", async () => {
  const b = fakeBridge(() => ({ dataUrl: "data:text/html;base64,PGI+" }));
  const t = getTool("browser_screenshot");
  await assert.rejects(t.run(b, {}), /image/i);
});

test("pi session is started with name pi-<cwd basename>", async () => {
  const { openPiSession, sessionNameFor } = await import("../adapters/pi/client.mjs");
  assert.equal(sessionNameFor("/x/cohand"), "pi-cohand");
  const calls = [];
  const fake = {
    session: null,
    async startSession(name) { calls.push(name); this.session = "abc"; },
  };
  assert.equal(await openPiSession(fake, "/x/cohand"), "abc");
  assert.deepEqual(calls, ["pi-cohand"]);
});

test("tools map onto cohand ops", async () => {
  const seen = [];
  const b = fakeBridge((p, op, args) => { seen.push([op, args]); return op === "cookies" ? { cookies: [{ name: "sid", domain: "a.com", httpOnly: true }] } : {}; });
  await getTool("browser_press").run(b, { key: "Enter" });
  await getTool("browser_get_text").run(b, { selector: "main" });
  const ck = await getTool("browser_cookies").run(b, { url: "https://a.com" });
  assert.deepEqual(seen[0], ["key", { combo: "Enter" }]);
  assert.deepEqual(seen[1], ["text", { selector: "main" }]);
  assert.match(ck.content, /sid/);
  assert.ok(!/=/.test(ck.content), "no cookie values");
});

test("client re-creates the session after 'unknown session'", async () => {
  const net = await import("node:net");
  const { createClient } = await import("../adapters/pi/client.mjs");
  const { LineDecoder, encodeLine } = await import("../host/framing.mjs");
  const { tmpHome } = await import("./helpers.mjs");
  const sock = path.join(tmpHome(), "s.sock");
  let starts = 0, tabsCalls = 0;
  const srv = net.createServer((c) => {
    const dec = new LineDecoder();
    c.on("data", (d) => { for (const m of dec.push(d)) {
      if (m.role) continue;
      if (m.op === "session.start") { starts++; c.write(encodeLine({ id: m.id, ok: true, data: { session: "s" + starts } })); }
      else if (m.session === "s1") c.write(encodeLine({ id: m.id, ok: false, error: "unknown session — start one" }));
      else { tabsCalls++; c.write(encodeLine({ id: m.id, ok: true, data: { tabs: [] } })); }
    } });
  });
  await new Promise((r) => srv.listen(sock, r));
  const c = createClient({ sock });
  await c.startSession("pi-x");
  assert.deepEqual(await c.request("tabs"), { tabs: [] });
  assert.equal(starts, 2);
  srv.close();
});
