// cohand doctor: ✔/✖ checklist with fix hints.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { paths } from "../daemon/paths.mjs";
import { LineDecoder, encodeLine } from "../host/framing.mjs";
import { extensionId, HOST_NAME, nativeMessagingDirs, systemdUserWorks, TMUX_SESSION } from "./install.mjs";

function ask(sock, op) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const dec = new LineDecoder();
    const t = setTimeout(() => { c.destroy(); reject(new Error("timeout")); }, 3000);
    c.once("error", (e) => { clearTimeout(t); reject(e); });
    c.once("connect", () => { c.write(encodeLine({ role: "client" })); c.write(encodeLine({ id: 1, op })); });
    c.on("data", (d) => { for (const m of dec.push(d)) if (m.id === 1) { clearTimeout(t); c.destroy(); resolve(m); } });
  });
}

function startHint(platform) {
  if (platform === "darwin") {
    return "run `cohand install`, or `launchctl kickstart gui/$(id -u)/com.cohand.daemon`";
  }
  if (platform === "linux" && systemdUserWorks()) {
    return "run `cohand install`, or `systemctl --user start com.cohand.daemon.service`";
  }
  if (platform === "linux") {
    return `run \`cohand install\`, or start the tmux session \`${TMUX_SESSION}\``;
  }
  return "run `cohand install`";
}

function defaultManifestFile(home, platform) {
  const dirs = nativeMessagingDirs(home, { platform, scanProc: false });
  return dirs[0] ? path.join(dirs[0], HOST_NAME + ".json") : null;
}

export async function checks({ home = os.homedir(), platform = process.platform } = {}) {
  const p = paths();
  const out = [];
  const add = (ok, msg, hint) => out.push({ ok, msg, hint });

  let profiles = null;
  let daemonUp = false;
  try {
    const r = await ask(p.sock, "profiles");
    profiles = r.data;
    daemonUp = true;
    add(true, "daemon is running");
  } catch {
    add(false, "daemon is not running", startHint(platform));
  }

  // Only trust socket permissions while the daemon is up; a leftover socket file is stale.
  let sockMode = null;
  try { sockMode = fs.statSync(p.sock).mode & 0o777; } catch {}
  if (sockMode === null) {
    add(false, "socket file missing", "start the daemon (`cohand install`)");
  } else if (!daemonUp) {
    add(false, "stale socket file (daemon not running)",
      "start the daemon (`cohand install`); the daemon removes a stale socket when it starts");
  } else {
    add(sockMode === 0o600, `socket permissions ${sockMode.toString(8)}`, "expected 600 — restart the daemon");
  }

  const manifestDirs = nativeMessagingDirs(home, { platform });
  const manifestFiles = manifestDirs.map((d) => path.join(d, HOST_NAME + ".json"));
  const found = [];
  const missing = [];
  for (const file of manifestFiles) {
    try {
      found.push({ file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) });
    } catch {
      missing.push(file);
    }
  }

  // The default Chrome path must exist; extra profile dirs should too if we planned them.
  const primary = defaultManifestFile(home, platform);
  const primaryOk = found.some((f) => f.file === primary);
  if (primaryOk && missing.length === 0) {
    add(true, found.length > 1 ? `host manifest installed (${found.length} locations)` : "host manifest installed");
  } else if (primaryOk) {
    add(false, `host manifest missing in ${missing.length} Chrome profile(s)`, "run `cohand install` to write NativeMessagingHosts for every Chrome user-data-dir");
  } else {
    add(false, "host manifest missing", "run `cohand install`");
  }

  const manifest = found[0]?.manifest || null;
  if (manifest) {
    const want = `chrome-extension://${extensionId()}/`;
    const originsOk = found.every((f) => f.manifest.allowed_origins?.includes(want));
    add(originsOk, "host manifest allows the cohand extension ID", "run `cohand install` to rewrite it");
    let ok = false;
    try { fs.accessSync(manifest.path, fs.constants.X_OK); ok = true; } catch {}
    add(ok, "host launcher exists and is executable", "run `cohand install`");
    let nodeOk = false;
    try {
      const body = fs.readFileSync(manifest.path, "utf8");
      nodeOk = /exec "([^"]+)"/.test(body) && fs.existsSync(/exec "([^"]+)"/.exec(body)[1]);
    } catch {}
    add(nodeOk, "node path in host launcher is valid", "run `cohand install` again after moving node");
  }

  if (profiles) {
    add(profiles.length > 0, profiles.length ? `profiles connected: ${profiles.join(", ")}` : "no profile connected",
      "in Chrome: chrome://extensions → Load unpacked → the cohand/extension folder, then open the popup and name the profile");
  }
  return out;
}

export async function run() {
  const res = await checks();
  for (const r of res) console.log(`${r.ok ? "✔" : "✖"} ${r.msg}${r.ok ? "" : `\n    fix: ${r.hint}`}`);
  return res.every((r) => r.ok) ? 0 : 1;
}
