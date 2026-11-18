import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDaemon } from "../daemon/server.mjs";
import { tmpHome, client, host } from "./helpers.mjs";

const echoHost = (sock, name) => host(sock, name, (m, h) => {
  if (m.type === "cmd") h.send({ type: "result", id: m.id, ok: true, data: { echoed: m.cmd, args: m.args } });
});

test("host announce shows in profiles", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const h = await echoHost(d.sock, "work");
  const c = await client(d.sock);
  assert.deepEqual((await c.request("profiles")).data, ["work"]);
  h.close(); c.close(); await d.close();
});

test("forwarded snapshot reaches host and result returns", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const h = await echoHost(d.sock, "work");
  const c = await client(d.sock);
  const s = (await c.request("session.start", { name: "t" })).data.session;
  const r = await c.request("snapshot", { x: 1 }, { session: s });
  assert.equal(r.ok, true);
  assert.equal(r.data.echoed, "snapshot");
  assert.equal(r.data.args.x, 1);
  assert.equal(r.data.args.session.name, "t");
  h.close(); c.close(); await d.close();
});

const focus = async (h, focused) => { h.send({ type: "event", event: "focus", data: { focused } }); await new Promise((r) => setTimeout(r, 60)); };
const tag = (sock, name) => host(sock, name, (m, h) => {
  if (m.type === "cmd") h.send({ type: "result", id: m.id, ok: true, data: { from: name } });
});

test("two profiles, no profile given: goes to the front profile; --profile overrides", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const a = await tag(d.sock, "alpha");
  const b = await tag(d.sock, "beta");
  const c = await client(d.sock);
  await focus(a, true);
  assert.equal((await c.request("tabs")).data.from, "alpha");
  assert.equal((await c.request("tabs", {}, { profile: "beta" })).data.from, "beta");
  a.close(); b.close(); c.close(); await d.close();
});

test("focus switch: new sessions go to the newly focused profile; existing session stays pinned", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const a = await tag(d.sock, "alpha");
  const b = await tag(d.sock, "beta");
  const c = await client(d.sock);
  await focus(a, true);
  const s1 = (await c.request("session.start", { name: "one" })).data.session;
  await focus(a, false);
  await focus(b, true);
  const s2 = (await c.request("session.start", { name: "two" })).data.session;
  assert.equal((await c.request("tabs", {}, { session: s1 })).data.from, "alpha");
  assert.equal((await c.request("tabs", {}, { session: s2 })).data.from, "beta");
  assert.equal((await c.request("tabs")).data.from, "beta");
  // blur keeps the last-focused profile in front
  await focus(b, false);
  assert.equal((await c.request("tabs")).data.from, "beta");
  a.close(); b.close(); c.close(); await d.close();
});

test("pinned session whose profile disconnected gets a clear error", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const a = await tag(d.sock, "alpha");
  const b = await tag(d.sock, "beta");
  const c = await client(d.sock);
  await focus(a, true);
  const s = (await c.request("session.start", { name: "one" })).data.session;
  a.close(); await new Promise((r) => setTimeout(r, 60));
  const r = await c.request("tabs", {}, { session: s });
  assert.equal(r.ok, false);
  assert.match(r.error, /profile alpha disconnected — reopen it or start a new session/);
  b.close(); c.close(); await d.close();
});

test("adopt forwards inspect and adopt while preserving the explicit tab id", async () => {
  const home = tmpHome();
  fs.writeFileSync(home + "/policy.json", JSON.stringify({ profiles: { work: { anyTab: true } } }));
  const d = await startDaemon({ home });
  const seen = [];
  const h = await host(d.sock, "work", (m, hh) => {
    if (m.type !== "cmd") return;
    seen.push({ cmd: m.cmd, args: m.args });
    hh.send({ type: "result", id: m.id, ok: true, data: m.cmd === "inspect" ? { url: "https://example.test/form", risky: false } : { tabId: m.args.tabId } });
  });
  const c = await client(d.sock);
  const s = (await c.request("session.start", { name: "handoff" })).data.session;
  const r = await c.request("adopt", { tabId: 1974326466, anyTab: true }, { session: s });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.map((x) => x.cmd), ["inspect", "adopt"]);
  assert.equal(seen[1].args.tabId, 1974326466);
  h.close(); c.close(); await d.close();
});

test("host disconnect mid-command gives 'profile work disconnected'", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const h = await host(d.sock, "work", (m, hh) => { if (m.type === "cmd") hh.close(); });
  const c = await client(d.sock);
  const r = await c.request("snapshot");
  assert.equal(r.ok, false);
  assert.match(r.error, /profile work disconnected/);
  c.close(); await d.close();
});

test("no reply -> timeout error", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const h = await host(d.sock, "work");
  const c = await client(d.sock);
  const r = await c.request("snapshot", {}, { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  h.close(); c.close(); await d.close();
});

test("socket mode is 0600; second daemon rejected", async () => {
  const home = tmpHome();
  const d = await startDaemon({ home });
  assert.equal(fs.statSync(d.sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  await assert.rejects(startDaemon({ home }), /cohandd already running/);
  await d.close();
});

test("stale socket file is replaced", async () => {
  const home = tmpHome();
  fs.writeFileSync(home + "/cohandd.sock", "");
  const d = await startDaemon({ home });
  await d.close();
});

test("session resume returns the same known session without creating another", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const h = await echoHost(d.sock, "work");
  const c = await client(d.sock);
  const started = (await c.request("session.start", { name: "ongoing" })).data;
  const resumed = await c.request("session.resume", { id: started.session });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.session, started.session);
  assert.equal((await c.request("session.list")).data.length, 1);
  h.close(); c.close(); await d.close();
});

test("session survives a daemon restart: sessions.json is 0600, resume works once its profile reconnects", async () => {
  const home = tmpHome();
  const d1 = await startDaemon({ home });
  const h1 = await echoHost(d1.sock, "work");
  const c1 = await client(d1.sock);
  const started = (await c1.request("session.start", { name: "persisted" })).data;
  h1.close(); c1.close(); await d1.close();

  const file = home + "/sessions.json";
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [
    { id: started.session, name: "persisted", profile: "work" },
  ]);

  const d2 = await startDaemon({ home });
  const c2 = await client(d2.sock);
  // The pin is honoured, not silently re-pointed at another profile: resume refuses until "work" reconnects.
  const offline = await c2.request("session.resume", { id: started.session });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /profile work/);
  assert.match(offline.error, /cohand session start/);

  const h2 = await echoHost(d2.sock, "work");
  const resumed = await c2.request("session.resume", { id: started.session });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.data, { session: started.session, name: "persisted", profile: "work", resumed: true });
  assert.deepEqual((await c2.request("session.list")).data, [
    { id: started.session, name: "persisted", profile: "work" },
  ]);

  const ended = await c2.request("session.end", {}, { session: started.session });
  assert.deepEqual(ended.data, { ended: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  h2.close(); c2.close(); await d2.close();

  // Ending is durable: a third daemon on the same home does not resurrect the session.
  const d3 = await startDaemon({ home });
  const c3 = await client(d3.sock);
  assert.deepEqual((await c3.request("session.list")).data, []);
  const gone = await c3.request("session.resume", { id: started.session });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /unknown session/);
  c3.close(); await d3.close();
});

test("corrupt sessions.json is quarantined and the daemon still starts", async () => {
  const home = tmpHome();
  fs.writeFileSync(home + "/sessions.json", "{ not json");
  const d = await startDaemon({ home });
  const c = await client(d.sock);
  assert.deepEqual((await c.request("session.list")).data, []);
  assert.equal(fs.existsSync(home + "/sessions.json.corrupt"), true);
  c.close(); await d.close();
});

test("persisted sessions with a missing id or name are dropped", async () => {
  const home = tmpHome();
  fs.writeFileSync(home + "/sessions.json", JSON.stringify([
    { id: "aaaa1111", name: "kept", profile: "work" },
    { name: "no-id", profile: "work" },
    { id: "bbbb2222" },
    null,
  ]));
  const d = await startDaemon({ home });
  const c = await client(d.sock);
  assert.deepEqual((await c.request("session.list")).data, [
    { id: "aaaa1111", name: "kept", profile: "work" },
  ]);
  c.close(); await d.close();
});

test("unknown session errors", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const h = await echoHost(d.sock, "work");
  const c = await client(d.sock);
  const r = await c.request("snapshot", {}, { session: "nope" });
  assert.match(r.error, /unknown session/);
  h.close(); c.close(); await d.close();
});
test("same profile registering again closes old host and fails its pending commands", async () => {
  const d = await startDaemon({ home: tmpHome() });
  let closed = false;
  const old = await host(d.sock, "work");
  old.conn.on("close", () => { closed = true; });
  const c = await client(d.sock);
  const pending = c.request("snapshot", {}, { timeoutMs: 3000 });
  await new Promise((r) => setTimeout(r, 100));
  const fresh = await echoHost(d.sock, "work");
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /profile work reconnected — retry/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, true);
  assert.equal((await c.request("snapshot")).ok, true);
  fresh.close(); c.close(); await d.close();
});

test("daemon tells each host whether it is the front profile", async () => {
  const d = await startDaemon({ home: tmpHome() });
  const got = { alpha: [], beta: [] };
  const rec = (n) => (m) => { if (m.type === "front") got[n].push(m.front); };
  const a = await host(d.sock, "alpha", rec("alpha"));
  const b = await host(d.sock, "beta", rec("beta"));
  await focus(b, true);
  await focus(a, true);
  assert.equal(got.alpha.at(-1), true);
  assert.equal(got.beta.at(-1), false);
  a.close(); b.close(); await d.close();
});
