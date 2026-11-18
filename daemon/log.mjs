import fs from "node:fs";
import path from "node:path";

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

const MAX_ERROR = 200;

/** Origin + path only: drops query and fragment (OAuth codes, magic-link tokens). Tolerates invalid URLs. */
export function redactUrl(url) {
  const s = String(url);
  try {
    const u = new URL(s);
    if (u.origin && u.origin !== "null") return u.origin + u.pathname;
  } catch { /* not an absolute URL — fall through */ }
  return s.replace(/[?#].*$/, "");
}

/** Cap error text and strip query strings from URLs embedded in it. */
export function redactError(message) {
  const stripped = String(message ?? "").replace(/https?:\/\/[^\s"'<>]+/g, (m) => redactUrl(m));
  if (stripped.length <= MAX_ERROR) return stripped;
  return stripped.slice(0, MAX_ERROR - 1) + "…";
}

function redactUrls(value) {
  if (Array.isArray(value)) return value.map(redactUrls);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "url" && typeof v === "string") out[k] = redactUrl(v);
    else out[k] = redactUrls(v);
  }
  return out;
}

export function redact(op, args = {}) {
  const out = redactUrls({ ...args });
  if (typeof out.text === "string") out.text = { len: out.text.length };
  if (typeof out.js === "string") out.js = { len: out.js.length };
  return out;
}

export function appendLog(dir, entry) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, today() + ".jsonl"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}

export function readLog(dir, day = today()) {
  const f = path.join(dir, day + ".jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
