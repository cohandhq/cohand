import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LineDecoder, encodeLine } from "../host/framing.mjs";

export const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "cohand-test-"));

/** Raw peer: connect, send hello, collect messages, request/response helper. */
export function peer(sock, hello, onMsg) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const dec = new LineDecoder();
    const waiters = new Map();
    c.on("error", reject);
    c.on("data", (d) => {
      for (const m of dec.push(d)) {
        if (m.id !== undefined && waiters.has(m.id) && m.type !== "cmd") { waiters.get(m.id)(m); waiters.delete(m.id); }
        else onMsg?.(m, api);
      }
    });
    let n = 1;
    const api = {
      conn: c,
      send: (m) => c.write(encodeLine(m)),
      request: (op, args = {}, extra = {}) => new Promise((res) => {
        const id = n++;
        waiters.set(id, res);
        c.write(encodeLine({ id, op, args, ...extra }));
      }),
      close: () => c.destroy(),
    };
    c.once("connect", () => { c.write(encodeLine(hello)); setTimeout(() => resolve(api), 30); });
  });
}
export const client = (sock) => peer(sock, { role: "client" });
export const host = (sock, profile, onMsg) => peer(sock, { role: "host", v: 1, profile }, onMsg);
