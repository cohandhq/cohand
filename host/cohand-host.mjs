#!/usr/bin/env node
// Native-messaging relay: Chrome stdio <-> cohandd unix socket. One per profile.
import net from "node:net";
import { spawn } from "node:child_process";
import { paths } from "../daemon/paths.mjs";
import { NativeDecoder, encodeNative, LineDecoder, encodeLine } from "./framing.mjs";

function ms(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const RETRY_MS = ms(process.env.COHAND_HOST_RETRY_MS, 1000);
const KICK_MS = ms(process.env.COHAND_HOST_KICK_MS, 5000);
const GIVE_UP_MS = ms(process.env.COHAND_HOST_GIVE_UP_MS, 30000);
const MAX_TO_CHROME = 1024 * 1024;
const sock = paths().sock;

let profile = null;
let conn = null;
const nativeIn = new NativeDecoder();

function kickDaemon() {
  if (process.env.COHAND_NO_LAUNCHCTL) return;
  try {
    // A custom command replaces the service-manager logic (tests, unusual installs).
    // Errors are swallowed: a missing tmux/systemctl/launchctl must never kill the host.
    const custom = process.env.COHAND_HOST_KICK_CMD;
    if (custom) {
      const p = spawn(custom, { shell: true, stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
      return;
    }
    if (process.platform === "darwin") {
      spawn("launchctl", ["kickstart", `gui/${process.getuid()}/com.cohand.daemon`], { stdio: "ignore", detached: true }).unref();
      return;
    }
    if (process.platform === "linux") {
      // Prefer systemd --user when a user instance is actually running; otherwise
      // start the installer-created tmux session named "cohand" if it is missing.
      const fallbackTmux = () => {
        const home = process.env.COHAND_HOME || `${process.env.HOME || ""}/.cohand`;
        const script = `${home}/supervise-daemon.sh`;
        const has = spawn("tmux", ["has-session", "-t", "=cohand"], { stdio: "ignore" });
        has.on("error", () => {});
        has.on("exit", (c) => {
          if (c === 0) return;
          spawn("tmux", ["new-session", "-d", "-s", "cohand", "-n", "daemon", script], { stdio: "ignore", detached: true }).unref();
        });
        has.unref();
      };
      const sys = spawn("systemctl", ["--user", "is-system-running"], { stdio: "ignore" });
      sys.on("error", fallbackTmux);
      sys.on("exit", (code) => {
        if (code === 0) {
          spawn("systemctl", ["--user", "start", "com.cohand.daemon.service"], { stdio: "ignore", detached: true }).unref();
          return;
        }
        fallbackTmux();
      });
      sys.unref();
    }
  } catch {}
}

function toChrome(obj) {
  const buf = encodeNative(obj);
  if (buf.length - 4 > MAX_TO_CHROME) obj = { type: "result", id: obj.id, ok: false, error: "message too large for Chrome" };
  process.stdout.write(encodeNative(obj));
}

async function connectLoop() {
  const started = Date.now();
  let lastKick = -Infinity;
  for (;;) {
    try {
      return await tryConnect();
    } catch {
      // Connect can fail because the daemon is down (ENOENT) or because a stale
      // socket file survived a SIGKILL/OOM/reboot (ECONNREFUSED). Kick in both
      // cases, at most once per KICK_MS. Never unlink the socket here:
      // startDaemon() already probes and unlinks a stale one.
      const now = Date.now();
      if (now - started > GIVE_UP_MS) process.exit(1);
      if (now - lastKick >= KICK_MS) { lastKick = now; kickDaemon(); }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

function tryConnect() {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    c.once("error", reject);
    c.once("connect", () => {
      c.off("error", reject);
      c.on("error", () => {});
      c.write(encodeLine({ role: "host", v: 1, profile }));
      const dec = new LineDecoder();
      c.on("data", (d) => { for (const m of dec.push(d)) if (!m.__error) toChrome(m); });
      c.on("close", () => { conn = null; startConnect(); });
      resolve(c);
    });
  });
}

const queue = []; // messages that arrive while the daemon connect is in flight
let connecting = false;

function flush() {
  while (queue.length && conn && !conn.destroyed) conn.write(encodeLine(queue.shift()));
}

function startConnect() {
  if (connecting) return;
  connecting = true;
  connectLoop().then((c) => { conn = c; connecting = false; flush(); });
}

process.stdin.on("data", (chunk) => {
  let msgs;
  try { msgs = nativeIn.push(chunk); } catch { process.exit(1); }
  for (const m of msgs) {
    if (!profile) {
      if (m.type !== "hello" || !m.profile) continue;
      profile = String(m.profile);
      startConnect();
    } else {
      queue.push(m);
      if (queue.length > 200) queue.shift();
      flush();
    }
  }
});
process.stdin.on("end", () => process.exit(0));
