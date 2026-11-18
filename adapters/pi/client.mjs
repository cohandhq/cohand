// cohandd client for the pi adapter: one-shot socket requests + a session that
// re-creates itself if the daemon restarted.
import net from "node:net";
import path from "node:path";
import { paths } from "../../daemon/paths.mjs";
import { LineDecoder, encodeLine } from "../../host/framing.mjs";

export const sessionNameFor = (cwd) => `pi-${path.basename(cwd || process.cwd()) || "session"}`;

function once(sock, req, waitMs) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const dec = new LineDecoder();
    const timer = setTimeout(() => { c.destroy(); reject(new Error("no answer from cohandd")); }, waitMs);
    c.once("error", () => { clearTimeout(timer); reject(new Error("cohandd not running — run `cohand doctor`")); });
    c.once("connect", () => { c.write(encodeLine({ role: "client" })); c.write(encodeLine({ id: 1, ...req })); });
    c.on("data", (d) => { for (const m of dec.push(d)) if (m.id === 1) { clearTimeout(timer); c.destroy(); resolve(m); } });
  });
}

export function createClient({ sock = paths().sock, waitMs = 150000 } = {}) {
  const state = { session: null, name: null };
  async function raw(op, args, extra) {
    const req = { op, args: args || {}, ...(extra || {}) };
    if (state.session && !["profiles", "session.start", "policy", "log"].includes(op)) req.session = state.session;
    const res = await once(sock, req, waitMs);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }
  const client = {
    get session() { return state.session; },
    async startSession(name) {
      state.name = name;
      state.session = (await raw("session.start", { name })).session;
      return state.session;
    },
    async request(op, args, extra) {
      try { return await raw(op, args, extra); }
      catch (e) {
        if (/unknown session/.test(e.message) && state.name) {
          await client.startSession(state.name);
          return raw(op, args, extra);
        }
        throw e;
      }
    },
    async endSession() {
      if (!state.session) return;
      try { await raw("session.end", {}); } catch {}
      state.session = null;
    },
  };
  return client;
}

/** Start the pi session for this working directory. */
export async function openPiSession(client, cwd) {
  await client.startSession(sessionNameFor(cwd));
  return client.session;
}
