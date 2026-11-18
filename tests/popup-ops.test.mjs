import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDaemon } from "../daemon/server.mjs";
import { tmpHome, client, host } from "./helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** host that answers popup "req" frames with whatever the daemon says */
function popupHost(sock, name, cmds = [], onCmd) {
  const res = new Map();
  let n = 1;
  return host(sock, name, (m, h) => {
    if (m.type === "res") res.get(m.id)?.(m);
    if (m.type === "cmd") {
      cmds.push(m);
      if (onCmd?.(m, h)) return;
      h.send({ type: "result", id: m.id, ok: true, data: { url: "https://a.com/" } });
    }
  }).then((h) => Object.assign(h, {
    call: (op, args = {}) => new Promise((r) => { const id = n++; res.set(id, r); h.send({ v: 1, type: "req", id, op, args }); }),
  }));
}

test("status.profile: front flag, pinned sessions, recent log for this profile only", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const cmds = [];
  const a = await popupHost(d.sock, "alpha", cmds);
  const b = await popupHost(d.sock, "beta");
  const c = await client(d.sock);
  a.send({ type: "event", event: "focus", data: { focused: true } }); await sleep(60);
  const s = (await c.request("session.start", { name: "bot" })).data.session;
  await c.request("tabs", {}, { session: s });
  const ra = await a.call("status.profile");
  assert.equal(ra.ok, true);
  assert.equal(ra.data.front, true);
  assert.deepEqual(ra.data.sessions.map((x) => [x.id, x.name, x.lastAction]), [[s, "bot", "tabs"]]);
  assert.equal(ra.data.recent.length, 1);
  assert.equal(ra.data.recent[0].op, "tabs");
  const rb = await b.call("status.profile");
  assert.equal(rb.data.front, false);
  assert.equal(rb.data.sessions.length, 0);
  assert.equal(rb.data.recent.length, 0);
  a.close(); b.close(); c.close(); await d.close();
});

test("policy.block writes this profile's block list in policy.json", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const a = await popupHost(d.sock, "alpha");
  const r = await a.call("policy.block", { domain: "news.com", on: true });
  assert.equal(r.ok, true);
  const file = JSON.parse(fs.readFileSync(home + "/policy.json", "utf8"));
  assert.deepEqual(file.profiles.alpha.block, ["news.com"]);
  assert.deepEqual((await a.call("status.profile")).data.block, ["news.com"]);
  await a.call("policy.block", { domain: "news.com", on: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(home + "/policy.json", "utf8")).profiles.alpha.block, []);
  a.close(); await d.close();
});

test("policy.anyTab toggles this profile's any-tab permission", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  const a = await popupHost(d.sock, "alpha");
  assert.equal((await a.call("status.profile")).data.anyTab, false);
  assert.equal((await a.call("policy.anyTab", { on: true })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(home + "/policy.json", "utf8")).profiles.alpha.anyTab, true);
  assert.equal((await a.call("status.profile")).data.anyTab, true);
  await a.call("policy.anyTab", { on: false });
  assert.equal(JSON.parse(fs.readFileSync(home + "/policy.json", "utf8")).profiles.alpha.anyTab, false);
  a.close(); await d.close();
});

test("session.end from the popup ends the session and tells the extension to ungroup", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const cmds = [];
  const a = await popupHost(d.sock, "alpha", cmds);
  const c = await client(d.sock);
  const s = (await c.request("session.start", { name: "bot" })).data.session;
  const r = await a.call("session.end", { session: s });
  assert.equal(r.ok, true);
  assert.equal((await c.request("session.list")).data.length, 0);
  assert.ok(cmds.find((m) => m.cmd === "session.end" && m.args.session.name === "bot"));
  // a profile cannot end another profile's session
  const b = await popupHost(d.sock, "beta");
  const s2 = (await c.request("session.start", { name: "x" }, { profile: "alpha" })).data.session;
  assert.equal((await b.call("session.end", { session: s2 })).ok, false);
  a.close(); b.close(); c.close(); await d.close();
});

test("popup ops are whitelisted", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const a = await popupHost(d.sock, "alpha");
  assert.equal((await a.call("eval", {})).ok, false);
  a.close(); await d.close();
});

test("pending ask-first requests are listed while waiting", async () => {
  const home = tmpHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(home + "/policy.json", JSON.stringify({ off: false, profiles: {}, defaults: { askFirst: true } }));
  const d = await startDaemon({ home, askTimeoutMs: 1500 });
  const cmds = [];
  let a;
  let c;
  try {
    a = await popupHost(d.sock, "alpha", cmds, (m, h) => {
      if (m.cmd === "ask") return true; // never answers by itself
      if (m.cmd === "inspect") { h.send({ type: "result", id: m.id, ok: true, data: { url: "https://a.com/", risky: false } }); return true; }
    });
    c = await client(d.sock);
    const s = (await c.request("session.start", { name: "bot" })).data.session;
    const pending = c.request("eval", { js: "1" }, { session: s });
    await sleep(150);
    const st = await a.call("status.profile");
    assert.equal(st.data.pending.length, 1);
    assert.match(st.data.pending[0].summary, /bot: eval/);
    const askCmd = cmds.find((m) => m.cmd === "ask");
    assert.equal(askCmd.args.askId, st.data.pending[0].id);
    // answering through the daemon (popup path) resolves the same waiter as the notification would
    a.send({ type: "result", id: askCmd.id, ok: true, data: { allow: true } });
    assert.equal((await pending).ok, true);
    assert.equal((await a.call("status.profile")).data.pending.length, 0);
  } finally {
    a?.close(); c?.close(); await d.close();
  }
});
