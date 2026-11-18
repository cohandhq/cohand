// cohandd core: unix socket server, host/client peers, routing.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.mjs";
import { Registry } from "./registry.mjs";
import { LineDecoder, encodeLine } from "../host/framing.mjs";
import { loadPolicy, savePolicy, check } from "./policy.mjs";
import { POPUP_OPS, endSession } from "./popup-ops.mjs";
import { appendLog, redact, redactError, redactUrl, readLog } from "./log.mjs";

function probe(sock) {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    c.once("connect", () => { c.destroy(); resolve(true); });
    c.once("error", () => resolve(false));
  });
}

export async function startDaemon(opts = {}) {
  const p = paths(opts.home);
  const defaultTimeout = opts.timeoutMs ?? 30000;
  fs.mkdirSync(p.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.home, 0o700);
  if (fs.existsSync(p.sock)) {
    if (await probe(p.sock)) throw new Error("cohandd already running");
    fs.unlinkSync(p.sock);
  }

  // Sessions are persisted here so a supervisor restart does not kill exported COHAND_SESSION ids.
  const sessionsFile = path.join(p.home, "sessions.json");
  const reg = new Registry({ sessionsFile });
  const ctx = { reg, paths: p, opts, defaultTimeout, nextId: 1, extra: { ...policyOps, ...(opts.extraOps || {}) }, hooks: { beforeForward: gate, ...(opts.hooks || {}) } };
  const conns = new Set();

  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    conn.on("error", () => {});
    const dec = new LineDecoder();
    let peer = null;
    conn.on("data", (chunk) => {
      for (const msg of dec.push(chunk)) {
        if (msg.__error) continue;
        if (!peer) { peer = attach(ctx, conn, msg); continue; }
        peer.onMessage(msg);
      }
    });
    conn.on("close", () => peer?.onClose?.());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p.sock, () => { server.off("error", reject); resolve(); });
  });
  fs.chmodSync(p.sock, 0o600);

  return {
    sock: p.sock,
    registry: reg,
    close: () => new Promise((resolve) => {
      for (const c of conns) c.destroy();
      server.close(() => { try { fs.unlinkSync(p.sock); } catch {} resolve(); });
    }),
  };
}

function attach(ctx, conn, hello) {
  if (hello.role === "host") return hostPeer(ctx, conn, hello);
  if (hello.role === "client") return clientPeer(ctx, conn);
  conn.destroy();
  return { onMessage() {}, onClose() {} };
}

function hostPeer(ctx, conn, hello) {
  const host = {
    name: String(hello.profile || "unnamed"),
    pending: new Map(),
    send: (frame) => conn.write(encodeLine(frame)),
    close: () => conn.destroy(),
    failAll(reason) {
      for (const [id, e] of host.pending) { clearTimeout(e.timer); e.reject(new Error(reason)); host.pending.delete(id); }
    },
  };
  const old = ctx.reg.addProfile(host);
  queueMicrotask(() => announceFront(ctx));
  if (old && old !== host) { old.failAll(`profile ${old.name} reconnected — retry`); old.replaced = true; old.close(); }
  return {
    onMessage(msg) {
      if (msg.type === "event") {
        if (msg.event === "focus") { ctx.reg.markFocus(host.name, msg.data?.focused === true); announceFront(ctx); }
        ctx.opts.onHostEvent?.(host.name, msg);
        return;
      }
      if (msg.type === "req") { popupReq(ctx, host, msg); return; }
      if (msg.type === "result" && host.pending.has(msg.id)) {
        const e = host.pending.get(msg.id);
        host.pending.delete(msg.id);
        clearTimeout(e.timer);
        if (msg.ok === false) e.reject(new Error(msg.error || "command failed"));
        else e.resolve(msg.data);
      }
    },
    onClose() {
      ctx.reg.removeProfile(host);
      announceFront(ctx);
      host.failAll(`profile ${host.name} disconnected`);
    },
  };
}

function popupReq(ctx, host, msg) {
  const reply = (ok, payload) => host.send(ok ? { v: 1, type: "res", id: msg.id, ok: true, data: payload } : { v: 1, type: "res", id: msg.id, ok: false, error: String(payload) });
  try {
    const fn = POPUP_OPS[msg.op];
    if (!fn) throw new Error(`op not allowed from the popup: ${msg.op}`);
    reply(true, fn(ctx, host.name, msg.args || {}));
  } catch (e) { reply(false, e.message); }
}

/** Tell each host whether it is the front profile (only when that changes). */
function announceFront(ctx) {
  const f = ctx.reg.front();
  for (const [name, h] of ctx.reg.profiles) {
    const is = name === f;
    if (h.lastFront === is) continue;
    h.lastFront = is;
    try { h.send({ v: 1, type: "front", front: is }); } catch {}
  }
}

/** Send a command to a profile's extension and await its result. */
export function dispatch(ctx, profileName, cmd, args, timeoutMs) {
  const host = ctx.reg.profiles.get(profileName);
  if (!host) return Promise.reject(new Error(`profile ${profileName} disconnected`));
  const id = ctx.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.pending.delete(id);
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    host.pending.set(id, { resolve, reject, timer });
    host.send({ v: 1, type: "cmd", id, cmd, args });
  });
}

function clientPeer(ctx, conn) {
  const reply = (id, ok, payload) =>
    conn.write(encodeLine(ok ? { id, ok: true, data: payload } : { id, ok: false, error: String(payload) }));
  return {
    async onMessage(req) {
      try {
        reply(req.id, true, await handle(ctx, req));
      } catch (e) {
        reply(req.id, false, e.message);
      }
    },
  };
}

async function handle(ctx, req) {
  const { reg } = ctx;
  const args = req.args || {};
  switch (req.op) {
    case "profiles": return reg.names();
    case "session.start": {
      if (!args.name) throw new Error("session name required");
      const pin = reg.choose(args.profile || req.profile, null);
      const session = reg.startSession(args.name, pin);
      return { session: session.id, name: session.name, profile: pin, resumed: false };
    }
    case "session.resume": {
      if (!args.id) throw new Error("session id required");
      const session = reg.resumeSession(args.id);
      return { session: session.id, name: session.name, profile: session.profile, resumed: true };
    }
    case "session.end": {
      if (!req.session) throw new Error("no session given");
      const s = reg.sessions.get(req.session);
      return s ? endSession(ctx, s) : { ended: false };
    }
    case "session.list": return reg.listSessions();
  }
  if (ctx.extra[req.op]) return ctx.extra[req.op](ctx, req);
  let session = null;
  if (req.session) {
    session = reg.sessions.get(req.session);
    if (!session) throw new Error("unknown session — start one with `cohand session start <name>`");
  }
  const profile = reg.choose(req.profile, session);
  const timeoutMs = req.timeoutMs ?? ctx.defaultTimeout;
  const fwdArgs = { ...args, ...(session ? { session: { id: session.id, name: session.name } } : {}) };
  if (ctx.hooks.beforeForward) return ctx.hooks.beforeForward(ctx, { req, profile, session, args: fwdArgs, timeoutMs });
  return dispatch(ctx, profile, req.op, fwdArgs, timeoutMs);
}

// ---- policy / log ops and the gate ----

const policyOps = {
  policy: (ctx) => loadPolicy(ctx.paths.policyFile),
  off: (ctx, req) => setOff(ctx, req, true),
  on: (ctx, req) => setOff(ctx, req, false),
  log: (ctx, req) => readLog(ctx.paths.logDir, req.args?.day),
};

function setOff(ctx, req, off) {
  const pol = loadPolicy(ctx.paths.policyFile);
  const profile = req.profile || req.args?.profile;
  if (profile) pol.profiles[profile] = { ...(pol.profiles[profile] || {}), off };
  else pol.off = off;
  savePolicy(ctx.paths.policyFile, pol);
  return { off, profile: profile || null };
}

const NO_INSPECT = new Set(["tabs", "open", "cookies", "downloads"]);

async function gate(ctx, { req, profile, session, args, timeoutMs }) {
  const policy = loadPolicy(ctx.paths.policyFile);
  const entry = { session: session?.name ?? null, profile, op: req.op, args: redact(req.op, req.args || {}) };
  const log = (extra) => appendLog(ctx.paths.logDir, { ...entry, ...extra });
  try {
    let url = req.op === "open" || req.op === "cookies" ? args.url : undefined;
    let topUrl;
    let frameUrls = [];
    let risky = false;
    const pre = check(policy, { profile, op: req.op, url, args: { anyTab: args.anyTab === true } });
    if (pre.verdict === "deny") throw Object.assign(new Error(pre.reason), { denied: "policy" });
    if (!NO_INSPECT.has(req.op)) {
      const info = await dispatch(ctx, profile, "inspect", { ...args, op: req.op }, timeoutMs);
      url = info?.url ?? url;
      topUrl = info?.topUrl;
      frameUrls = Array.isArray(info?.frameUrls) ? info.frameUrls : [];
      risky = info?.risky === true;
    }
    entry.url = url ? redactUrl(url) : url;
    const checkedUrls = [...new Set([url, topUrl, ...frameUrls].filter(Boolean))];
    if (!checkedUrls.length) checkedUrls.push(undefined);
    const verdicts = checkedUrls.map((checkedUrl) => check(policy, { profile, op: req.op, url: checkedUrl, args: { ...args, risky } }));
    const denied = verdicts.find((result) => result.verdict === "deny");
    if (denied) throw Object.assign(new Error(denied.reason), { denied: "policy" });
    const v = verdicts.find((result) => result.verdict === "ask") || verdicts[0];
    if (v.verdict === "ask") {
      const askMs = ctx.opts.askTimeoutMs ?? 16000;
      let allow = false, why = "timeout";
      const askId = `ask${ctx.nextId++}`;
      const summary = `${session?.name ?? "agent"}: ${req.op} on ${url ?? "page"} (${v.reason})`;
      ctx.reg.asks.set(askId, { id: askId, profile, summary, at: new Date().toISOString() });
      try {
        const a = await dispatch(ctx, profile, "ask", { summary, askId }, askMs);
        allow = a?.allow === true;
        why = a?.timedOut ? "timeout" : "user";
      } catch { /* timeout or disconnect -> deny */ }
      finally { ctx.reg.asks.delete(askId); }
      if (!allow) throw Object.assign(new Error(why === "timeout" ? "denied: no answer to the approval prompt" : "denied by user"), { denied: why });
    }
    const data = await dispatch(ctx, profile, req.op, args, timeoutMs);
    log({ result: "ok", verdict: v.verdict });
    return data;
  } catch (e) {
    if (e.denied) log({ result: "denied", denied: e.denied, error: redactError(e.message) });
    else log({ result: "error", error: redactError(e.message) });
    throw e;
  }
}
