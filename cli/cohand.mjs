#!/usr/bin/env node
// cohand CLI: one-shot commands over the cohandd unix socket.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../daemon/paths.mjs";
import { LineDecoder, encodeLine } from "../host/framing.mjs";
import { COMMANDS, SESSION_SUB, parseArgs } from "./commands.mjs";

const MAX_PRINT = 15000;
const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const tmpDir = () => process.env.COHAND_TMP || paths().tmp;
const usage = (msg) => { console.error(`cohand: ${msg}\nrun \`cohand --help\` for commands`); process.exit(2); };

function help() {
  console.log(`cohand <command> [args] [--profile p] [--session id] [--json] [--timeout ms]
commands: ${[...Object.keys(COMMANDS), "session start|resume|end|list", "doctor", "install"].join(", ")}
session: cohand session start <name>  (then export COHAND_SESSION=<id>; add --quiet/-q for just the id)
         cohand session resume <id>  (reuse the live session; add --quiet/-q for just the id)`);
}

function cmdHelp(name, spec) {
  const pos = (spec.pos || []).map(([k]) => ` <${k}>`).join("");
  const flags = Object.entries(spec.flags || {}).map(([f, [, t]]) => `--${f}${t === "bool" ? "" : ` <${t}>`}`);
  console.log(`cohand ${name}${pos}${flags.length ? ` [${flags.join("] [")}]` : ""}\nglobal: [--profile p] [--session id] [--json] [--timeout ms] [--any-tab] [--no-show]`);
}

function request(req, waitMs) {
  return new Promise((resolve, reject) => {
    const c = net.connect(paths().sock);
    const dec = new LineDecoder();
    const timer = setTimeout(() => { c.destroy(); reject(Object.assign(new Error("no answer from cohandd"), { code: "TIMEOUT" })); }, waitMs);
    c.once("error", (e) => { clearTimeout(timer); reject(Object.assign(new Error("cohandd not running — run `cohand doctor`"), { code: "DOWN", cause: e })); });
    c.once("connect", () => { c.write(encodeLine({ role: "client" })); c.write(encodeLine({ id: 1, ...req })); });
    c.on("data", (d) => {
      for (const m of dec.push(d)) if (m.id === 1) { clearTimeout(timer); c.destroy(); resolve(m); }
    });
  });
}

/** Best-effort cleanup of scratch files older than 7 days. */
function pruneTmpDir(dir) {
  try {
    const cutoff = Date.now() - TMP_MAX_AGE_MS;
    for (const name of fs.readdirSync(dir)) {
      try {
        const f = path.join(dir, name);
        const st = fs.statSync(f);
        if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** Private scratch dir: 0700 even if it already exists; stale files pruned. */
function prepareTmpDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  pruneTmpDir(dir);
}

function saveFile(ext, buf) {
  const dir = tmpDir();
  prepareTmpDir(dir);
  const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  fs.writeFileSync(f, buf, { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
  return f;
}

function clip(text) {
  if (text.length <= MAX_PRINT) return text;
  const f = saveFile("txt", text);
  return `${text.slice(0, MAX_PRINT)}\n…[truncated ${MAX_PRINT}/${text.length} chars — full output: ${f}]`;
}

function render(op, data) {
  if (data && typeof data === "object" && typeof data.dataUrl === "string") {
    const m = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(data.dataUrl);
    if (!m) throw new Error("screenshot failed: extension returned non-image data");
    const file = saveFile(m[1] === "jpeg" ? "jpg" : "png", Buffer.from(m[2], "base64"));
    const scale = Number(data.deviceScaleFactor);
    if (!(Number.isFinite(scale) && scale > 0)) return file;
    let note = `Screenshot scale: ${scale}x (device pixels per page pixel)\nCSS pixels = image pixels / ${scale}`;
    const zoom = Number(data.pageZoom);
    if (Number.isFinite(zoom) && zoom > 0 && zoom !== 1) note += ` / ${zoom}`;
    return `${file}\n${note}`;
  }
  if (op === "tabs") {
    const tabs = data.tabs || [];
    return tabs.length
      ? tabs.map((t) => `${t.active ? "*" : " "} ${t.tabId} ${(t.title || "").slice(0, 80)} — ${(t.url || "").slice(0, 120)}`).join("\n")
      : "(no tabs in session group — drag a tab in or `cohand open <url>`)";
  }
  if (op === "console" || op === "network") {
    const lines = (data.items || []).map((i) => (i.level ? `[${i.level}] ${i.text}` : `${i.status} ${i.url}`));
    return clip([data.note, ...lines].filter(Boolean).join("\n") || "(nothing captured)");
  }
  if (op === "session.start" || op === "session.resume") return `export COHAND_SESSION=${data.session}`;
  if (op === "url") return data.url || "(no URL)";
  if (op === "log") return (data || []).map((e) => {
    const time = String(e.t || "").slice(11, 19) || "--:--:--";
    const url = String(e.url || "-");
    const verdict = e.verdict || e.denied || e.result || "-";
    return `${time} session=${e.session || "-"} action=${e.op || "-"} url=${url} verdict=${verdict}`;
  }).join("\n") || "(no log entries today)";
  if (typeof data === "string") return clip(data);
  if (Array.isArray(data) && data.every((x) => typeof x === "string")) return data.join("\n") || "(none)";
  if (data && typeof data.text === "string") return clip(data.text);
  return clip(JSON.stringify(data ?? {}, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") return help();
  let name = argv.shift();

  if (name === "doctor" || name === "install") {
    // Check flags before importing: `install --help` must never run the install.
    const allowed = name === "install" ? ["--dry-run"] : [];
    if (argv.includes("--help") || argv.includes("-h")) {
      console.log(name === "install"
        ? "cohand install [--dry-run]\nSets up the daemon, the Chrome native-messaging host, the cohand command and agent skills. --dry-run prints the plan without changing anything."
        : "cohand doctor\nChecks the daemon, native-messaging host, extension and skills, and prints what to fix.");
      return;
    }
    const unknown = argv.find((a) => !allowed.includes(a));
    if (unknown) usage(`unknown ${name} option "${unknown}"`);
    const mod = await import(`./${name}.mjs`).catch(() => null);
    if (!mod) usage(`${name} is not available`);
    process.exit((await mod.run(argv)) ?? 0);
  }

  let spec;
  let displayName = name;
  if (name === "session") {
    const sub = argv.shift();
    spec = SESSION_SUB[sub];
    if (!spec) usage(`unknown session command "${sub ?? ""}" (start|resume|end|list)`);
    displayName = `session ${sub}`;
  } else {
    spec = COMMANDS[name];
    if (!spec) usage(`unknown command "${name}"`);
  }

  if (argv.includes("--help") || argv.includes("-h")) return cmdHelp(displayName, spec);

  let parsed;
  try { parsed = parseArgs(spec, argv); } catch (e) { usage(e.message); }
  const { args, globals } = parsed;
  const session = globals.session || process.env.COHAND_SESSION;
  const req = { op: spec.op, args };
  if (session && !["session.start", "session.resume"].includes(spec.op)) req.session = session;
  if (globals.profile) req.profile = globals.profile;
  if (globals.timeout) req.timeoutMs = globals.timeout;
  // wait has its own in-page deadline; let --timeout drive it, ending just before the command times out.
  if (globals.timeout && spec.op === "wait") args.timeoutMs = Math.max(100, globals.timeout - 500);
  // policy/log/off/on talk about the daemon itself, not a session
  if (["policy", "log", "off", "on", "profiles"].includes(spec.op)) delete req.session;

  let res;
  try {
    res = await request(req, (globals.timeout ?? 30000) + 125000);
  } catch (e) {
    console.error(e.message);
    process.exit(e.code === "DOWN" ? 3 : 1);
  }
  if (!res.ok) { console.error(`cohand: ${res.error}`); process.exit(1); }
  if (globals.json) console.log(JSON.stringify(res.data));
  else if (["session.start", "session.resume"].includes(spec.op) && args.quiet) console.log(res.data.session);
  else console.log(render(spec.op, res.data));
}

main().catch((e) => { console.error(`cohand: ${e.message}`); process.exit(1); });
