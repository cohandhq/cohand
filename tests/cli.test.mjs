import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startDaemon } from "../daemon/server.mjs";
import { tmpHome, host } from "./helpers.mjs";
import { COMMANDS, SESSION_SUB, parseArgs } from "../cli/commands.mjs";

const CLI = new URL("../cli/cohand.mjs", import.meta.url).pathname;
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function run(home, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COHAND_")));
    const c = spawn("node", [CLI, ...args], { env: { ...cleanEnv, COHAND_HOME: home, COHAND_TMP: path.join(home, "tmp"), ...extraEnv } });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

test("cli end to end against daemon + fake host", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const seen = [];
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    let data = {};
    if (m.cmd === "inspect") data = { url: "https://a.com/", risky: false };
    else if (m.cmd === "screenshot") data = { dataUrl: TINY_PNG, deviceScaleFactor: 2 };
    else if (m.cmd === "url") data = { url: "https://current.test/page" };
    else seen.push({ cmd: m.cmd, args: m.args });
    hh.send({ type: "result", id: m.id, ok: true, data });
  });

  const p = await run(home, ["profiles", "--json"]);
  assert.deepEqual(JSON.parse(p.out), ["work"]);

  const t = await run(home, ["type", "e3", "hello"]);
  assert.equal(t.code, 0, t.err);
  assert.deepEqual(seen.at(-1), { cmd: "type", args: { ref: "e3", text: "hello" } });

  await run(home, ["click", "10,20"]);
  assert.deepEqual(seen.at(-1).args, { x: 10, y: 20 });

  const s = await run(home, ["screenshot"]);
  assert.equal(s.code, 0, s.err);
  const screenshotPath = s.out.split("\n")[0];
  assert.ok(fs.existsSync(screenshotPath), s.out);
  assert.match(s.out, /Screenshot scale: 2x/);

  const bad = await run(home, ["frobnicate"]);
  assert.equal(bad.code, 2);

  const missing = await run(home, ["type", "e3"]);
  assert.equal(missing.code, 2);

  const ss = await run(home, ["session", "start", "t1"]);
  assert.match(ss.out, /^export COHAND_SESSION=[0-9a-f]+$/);
  const sessionId = ss.out.split("=")[1];
  const sessionType = await run(home, ["type", "e3", "session text", "--session", sessionId]);
  assert.equal(sessionType.code, 0, sessionType.err);

  const quiet = await run(home, ["session", "start", "t2", "-q"]);
  assert.match(quiet.out, /^[0-9a-f]+$/);

  const url = await run(home, ["url"]);
  assert.equal(url.code, 0, url.err);
  assert.equal(url.out, "https://current.test/page");

  const log = await run(home, ["log", "--today"]);
  assert.equal(log.code, 0, log.err);
  assert.match(log.out, /\d{2}:\d{2}:\d{2}.*session=t1.*action=type/);
  assert.doesNotMatch(log.out, /^\s*\{/);

  process.env.COHAND_SESSION = "stale-session-from-shell";
  try {
    const inherited = await run(home, ["url"]);
    assert.equal(inherited.code, 0, inherited.err);
  } finally { delete process.env.COHAND_SESSION; }

  h.close(); await d.close();
});

test("daemon down -> exit 3 with message", async () => {
  const r = await run(tmpHome(), ["tabs"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /cohandd not running/);
});

test("adopt and session resume parse explicit ids and any-tab", () => {
  assert.deepEqual(parseArgs(COMMANDS.adopt, ["1974326466", "--any-tab"]), { args: { tabId: 1974326466, anyTab: true }, globals: { "any-tab": true } });
  assert.deepEqual(parseArgs(SESSION_SUB.resume, ["abc123", "-q"]), { args: { id: "abc123", quiet: true }, globals: {} });
});

test("--help prints usage and does not run the command (no daemon needed)", async () => {
  const home = tmpHome();
  const r = await run(home, ["snapshot", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^cohand snapshot .*--scope <str>.*--page <num>/s);
  const r2 = await run(home, ["click", "-h"]);
  assert.match(r2.out, /^cohand click <ref>/);
  const r3 = await run(home, ["adopt", "-h"]);
  assert.match(r3.out, /^cohand adopt <tabId>/);
  const r4 = await run(home, ["session", "resume", "-h"]);
  assert.match(r4.out, /^cohand session resume <id>/);
});
