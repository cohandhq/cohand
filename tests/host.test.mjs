import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startDaemon } from "../daemon/server.mjs";
import { NativeDecoder, encodeNative } from "../host/framing.mjs";
import { tmpHome, client } from "./helpers.mjs";

const HOST = new URL("../host/cohand-host.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn the real host. opts.kickCmd replaces the service-manager kick with a
 * shell command; opts.kickMs/giveUpMs shrink the production 5s/30s timers.
 */
function spawnHost(home, opts = {}) {
  const env = {
    ...process.env,
    COHAND_HOME: home,
    COHAND_HOST_RETRY_MS: String(opts.retryMs ?? 100),
    COHAND_NO_LAUNCHCTL: "1",
  };
  if (opts.kickCmd) { env.COHAND_HOST_KICK_CMD = opts.kickCmd; delete env.COHAND_NO_LAUNCHCTL; }
  if (opts.kickMs !== undefined) env.COHAND_HOST_KICK_MS = String(opts.kickMs);
  if (opts.giveUpMs !== undefined) env.COHAND_HOST_GIVE_UP_MS = String(opts.giveUpMs);

  const child = spawn("node", [HOST], { env, stdio: ["pipe", "pipe", "inherit"] });
  const frames = [];
  const dec = new NativeDecoder();
  child.stdout.on("data", (d) => {
    for (const f of dec.push(d)) {
      if (f.type === "cmd" && f.cmd === "inspect") child.stdin.write(encodeNative({ type: "result", id: f.id, ok: true, data: { url: "https://a.com/", risky: false } }));
      else frames.push(f);
    }
  });
  const exited = new Promise((res) => child.once("exit", (code, signal) => res({ code, signal })));
  after(() => child.kill());
  child.stdin.write(encodeNative({ type: "hello", v: 1, profile: "work" }));
  return { child, frames, exited };
}

/** Kick command that appends the current epoch-ms to `file` (one line per kick). */
const kickRecorder = (file) =>
  `node -e 'require("node:fs").appendFileSync(process.argv[1], Date.now() + "\\n")' '${file}'`;

const readKicks = (file) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number)
    : [];

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  return false;
}

test("hello registers profile; cmd arrives as native frame; reconnects after daemon restart", async () => {
  const home = tmpHome();
  let d = await startDaemon({ home });
  const { child, frames } = spawnHost(home);
  const c = await client(d.sock);
  assert.ok(await until(async () => (await c.request("profiles")).data.includes("work"), 3000));

  const pending = c.request("snapshot", {}, { timeoutMs: 2000 });
  assert.ok(await until(() => frames.find((f) => f.type === "cmd" && f.cmd === "snapshot"), 2000));
  const cmd = frames.find((f) => f.type === "cmd");
  child.stdin.write(encodeNative({ type: "result", id: cmd.id, ok: true, data: { fine: true } }));
  assert.deepEqual((await pending).data, { fine: true });

  c.close();
  await d.close();
  d = await startDaemon({ home });
  const c2 = await client(d.sock);
  assert.ok(await until(async () => (await c2.request("profiles")).data.includes("work"), 5000));
  child.kill(); c2.close(); await d.close();
});

test("messages sent while the daemon connect is in flight are queued, not dropped", async () => {
  const home = tmpHome();
  // daemon not up yet: host retries; extension sends an event meanwhile
  const { child } = spawnHost(home);
  await sleep(300);
  child.stdin.write(encodeNative({ type: "event", event: "focus", data: { focused: true } }));
  await sleep(300);
  const seen = [];
  const d = await startDaemon({ home, onHostEvent: (name, ev) => seen.push([name, ev]) });
  assert.ok(await until(() => seen.length, 4000));
  assert.equal(seen[0][1].event, "focus");
  child.kill(); await d.close();
});

test("stale socket file: the host kicks the daemon anyway, rate-limited", async () => {
  const home = tmpHome();
  // A SIGKILL/OOM/reboot leaves a regular file behind; nothing is listening on it.
  const sock = path.join(home, "cohandd.sock");
  fs.writeFileSync(sock, "");
  const sentinel = path.join(home, "kicked");

  const { exited } = spawnHost(home, {
    kickCmd: kickRecorder(sentinel),
    kickMs: 400,
    giveUpMs: 1400,
    retryMs: 50,
  });

  // First kick happens on the very first refused connect, not on the give-up timer.
  assert.ok(await until(() => readKicks(sentinel).length > 0, 1000), "kick never ran despite the stale socket file");

  const { code } = await exited;
  assert.notEqual(code, 0, "host should exit non-zero after the give-up deadline");
  await sleep(300); // let the last detached kick land

  const kicks = readKicks(sentinel);
  assert.ok(kicks.length >= 2, `expected repeated kicks, got ${kicks.length}`);
  // ~1400ms of 50ms retries would be ~28 kicks if not rate-limited at 400ms.
  assert.ok(kicks.length <= 6, `kicks were not rate-limited (${kicks.length} in ~1.4s)`);
  for (let i = 1; i < kicks.length; i++) {
    assert.ok(kicks[i] - kicks[i - 1] >= 350, `kicks too close together: ${kicks[i] - kicks[i - 1]}ms`);
  }
  assert.ok(fs.existsSync(sock), "the host must never unlink the socket file");
});

test("no daemon and a kick that does nothing: the host exits non-zero after the deadline", async () => {
  const home = tmpHome();
  const sentinel = path.join(home, "kicked");
  const t0 = Date.now();
  const { exited } = spawnHost(home, { kickCmd: kickRecorder(sentinel), kickMs: 100, giveUpMs: 600, retryMs: 50 });

  const { code } = await exited;
  const elapsed = Date.now() - t0;
  assert.notEqual(code, 0, "host must exit non-zero when the daemon never appears");
  assert.ok(elapsed >= 600, `gave up too early (${elapsed}ms)`);
  assert.ok(elapsed < 5000, `gave up far too late (${elapsed}ms)`);
  assert.ok(readKicks(sentinel).length > 0, "a kick should have been attempted before giving up");
});

test("daemon already running: no kick is spawned and frames still relay", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const sentinel = path.join(home, "kicked");
  const { child, frames } = spawnHost(home, { kickCmd: kickRecorder(sentinel), kickMs: 100, giveUpMs: 3000 });
  const c = await client(d.sock);
  assert.ok(await until(async () => (await c.request("profiles")).data.includes("work"), 3000));

  const pending = c.request("snapshot", {}, { timeoutMs: 2000 });
  assert.ok(await until(() => frames.find((f) => f.type === "cmd" && f.cmd === "snapshot"), 2000));
  const cmd = frames.find((f) => f.type === "cmd");
  child.stdin.write(encodeNative({ type: "result", id: cmd.id, ok: true, data: { fine: true } }));
  assert.deepEqual((await pending).data, { fine: true });

  await sleep(150);
  assert.equal(readKicks(sentinel).length, 0, "a successful connect must not kick the daemon");
  child.kill(); c.close(); await d.close();
});
