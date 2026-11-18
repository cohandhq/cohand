// cohand install: host manifest, login supervisor, PATH symlink, agent skills. Idempotent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_NAME = "com.cohand.host";
export const LABEL = "com.cohand.daemon";
export const SERVICE = `${LABEL}.service`;
export const TMUX_SESSION = "cohand";
export const extensionId = () => fs.readFileSync(path.join(ROOT, "shared/extension-id.txt"), "utf8").trim();

function same(file, content) {
  try { return fs.readFileSync(file, "utf8") === content; } catch { return false; }
}

function plat(p) {
  return p || process.platform;
}

/** True when a user systemd instance is actually usable (not just that systemctl exists). */
export function systemdUserWorks() {
  const r = spawnSync("systemctl", ["--user", "is-system-running"], {
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) return false;
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  // 0 = running; "degraded" also means the user instance is up.
  return r.status === 0 || out === "running" || out === "degraded";
}

function userDataDirsFromProc() {
  const dirs = new Set();
  let pids;
  try { pids = fs.readdirSync("/proc"); } catch { return dirs; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let raw;
    try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
    const args = raw.split("\0");
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let dir;
      if (a === "--user-data-dir" && args[i + 1]) dir = args[i + 1];
      else if (a.startsWith("--user-data-dir=")) dir = a.slice("--user-data-dir=".length);
      if (!dir) continue;
      if ((dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'"))) {
        dir = dir.slice(1, -1);
      }
      dirs.add(dir);
    }
  }
  return dirs;
}

/** A Chrome user-data dir is marked by a `Local State` file at its root (issue #36). */
export function looksLikeUserDataDir(dir) {
  try { return fs.existsSync(path.join(dir, "Local State")); } catch { return false; }
}

/**
 * Chrome/Chromium user-data dirs whose NativeMessagingHosts/ should get the host manifest.
 * On Linux, Chrome launched with --user-data-dir reads <user-data-dir>/NativeMessagingHosts
 * rather than ~/.config/google-chrome/NativeMessagingHosts.
 *
 * `scanProc` defaults to true only when `home` is the real home, so tests using a temp
 * HOME do not write into the machine's live Chrome profiles.
 */
export function chromeUserDataDirs(home, { scanProc, platform } = {}) {
  const p = plat(platform);
  const dirs = new Set();
  if (p === "darwin") {
    dirs.add(path.join(home, "Library/Application Support/Google/Chrome"));
    return [...dirs];
  }
  if (p !== "linux") return [...dirs];

  // Always include the default Google Chrome config dir (create on install).
  dirs.add(path.join(home, ".config/google-chrome"));
  for (const name of ["google-chrome-beta", "google-chrome-unstable", "chromium"]) {
    const d = path.join(home, ".config", name);
    if (fs.existsSync(d)) dirs.add(d);
  }
  // `~/chrome-profile` is itself a user-data dir when it has `Local State`, and its child
  // profiles (e.g. Fork-5) are only those children that have their own `Local State`.
  // Everything else (Default, Dictionaries, NativeMessagingHosts, caches) is Chrome internals.
  const customRoot = path.join(home, "chrome-profile");
  if (looksLikeUserDataDir(customRoot)) dirs.add(customRoot);
  try {
    for (const ent of fs.readdirSync(customRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const d = path.join(customRoot, ent.name);
      if (looksLikeUserDataDir(d)) dirs.add(d);
    }
  } catch {}
  const extra = process.env.COHAND_CHROME_USER_DATA_DIRS;
  if (extra) {
    for (const part of extra.split(path.delimiter)) {
      if (part) dirs.add(part);
    }
  }
  const doScan = scanProc ?? (path.resolve(home) === path.resolve(os.homedir()));
  if (doScan) {
    for (const dir of userDataDirsFromProc()) {
      const resolved = dir.startsWith("~/") ? path.join(home, dir.slice(2)) : path.resolve(dir);
      dirs.add(resolved);
    }
  }
  return [...dirs];
}

export function nativeMessagingDirs(home, opts = {}) {
  return chromeUserDataDirs(home, opts).map((d) => path.join(d, "NativeMessagingHosts"));
}

function hostWrapper(cohandHome, node) {
  const wrapper = path.join(cohandHome, "cohand-host.sh");
  const wrapperBody = `#!/bin/sh\nexec "${node}" "${path.join(ROOT, "host/cohand-host.mjs")}"\n`;
  return { wrapper, wrapperBody };
}

function hostManifestBody(wrapper, id) {
  return JSON.stringify({
    name: HOST_NAME,
    description: "cohand native messaging host",
    path: wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2) + "\n";
}

function launchdPlist({ node, cohandHome, home }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${path.join(ROOT, "daemon/main.mjs")}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(cohandHome, "cohandd.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(cohandHome, "cohandd.log")}</string>
</dict>
</plist>
`;
}

function systemdUnit({ node, cohandHome }) {
  return `[Unit]
Description=cohand daemon
After=default.target

[Service]
Type=simple
ExecStart="${node}" "${path.join(ROOT, "daemon/main.mjs")}"
Restart=always
RestartSec=2
StandardOutput=append:${path.join(cohandHome, "cohandd.log")}
StandardError=append:${path.join(cohandHome, "cohandd.log")}

[Install]
WantedBy=default.target
`;
}

function superviseScript({ node, cohandHome }) {
  const main = path.join(ROOT, "daemon/main.mjs");
  const log = path.join(cohandHome, "cohandd.log");
  const supLog = path.join(cohandHome, "cohandd.supervise.log");
  return `#!/bin/bash
set -u
mkdir -p "${cohandHome}"
while true; do
  echo "$(date -Iseconds) starting cohandd" >> "${supLog}"
  "${node}" "${main}" >> "${log}" 2>&1
  code=$?
  echo "$(date -Iseconds) cohandd exited \${code}; restarting in 2s" >> "${supLog}"
  sleep 2
done
`;
}

function skillDirs(home) {
  // ~/.agents/skills is the shared Agent Skills location (agentskills.io); always install there.
  const shared = path.join(home, ".agents/skills");
  return [
    shared,
    ...[
      path.join(home, ".claude/skills"),
      path.join(home, ".codex/skills"),
      path.join(home, ".pi/agent/skills"),
      path.join(home, ".config/opencode/skills"),
      path.join(home, ".grok/skills"),
      path.join(home, ".cursor/skills"),
      path.join(home, ".gemini/skills"),
      path.join(home, ".gemini/antigravity/skills"),
      path.join(home, ".copilot/skills"),
      path.join(home, ".factory/skills"),
      path.join(home, ".kiro/skills"),
      path.join(home, ".config/goose/skills"),
    ].filter((d) => fs.existsSync(path.dirname(d))),
  ];
}

export function plan({ home, cohandHome, node, platform } = {}) {
  const p = plat(platform);
  const id = extensionId();
  const { wrapper, wrapperBody } = hostWrapper(cohandHome, node);
  const manifest = hostManifestBody(wrapper, id);
  const skillSrc = fs.readFileSync(path.join(ROOT, "skill/SKILL.md"), "utf8");
  const files = [
    { file: wrapper, body: wrapperBody, mode: 0o755 },
    ...nativeMessagingDirs(home, { platform: p }).map((d) => ({
      file: path.join(d, HOST_NAME + ".json"),
      body: manifest,
      mode: 0o644,
    })),
    ...skillDirs(home).map((d) => ({ file: path.join(d, "cohand/SKILL.md"), body: skillSrc, mode: 0o644 })),
  ];
  if (p === "darwin") {
    files.push({
      file: path.join(home, "Library/LaunchAgents", LABEL + ".plist"),
      body: launchdPlist({ node, cohandHome, home }),
      mode: 0o644,
    });
  } else if (p === "linux") {
    files.push(
      { file: path.join(home, ".config/systemd/user", SERVICE), body: systemdUnit({ node, cohandHome }), mode: 0o644 },
      { file: path.join(cohandHome, "supervise-daemon.sh"), body: superviseScript({ node, cohandHome }), mode: 0o755 },
    );
  }
  return {
    platform: p,
    files,
    link: { from: path.join(home, ".local/bin/cohand"), to: path.join(ROOT, "cli/cohand.mjs") },
    systemdUnit: path.join(home, ".config/systemd/user", SERVICE),
    supervise: path.join(cohandHome, "supervise-daemon.sh"),
    plist: path.join(home, "Library/LaunchAgents", LABEL + ".plist"),
  };
}

function startLaunchd({ uid, plistFile, plistChanged, out }) {
  const loaded = spawnSync("launchctl", ["print", `gui/${uid}/${LABEL}`], { stdio: "ignore" }).status === 0;
  if (plistChanged && loaded) spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  if (plistChanged || !loaded) {
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistFile], { encoding: "utf8" });
    out.push({ what: "launchctl bootstrap", status: r.status === 0 ? "wrote" : `failed: ${(r.stderr || "").trim()}` });
  } else out.push({ what: "launchctl bootstrap", status: "unchanged" });
}

function startSystemdUser({ unitFile, unitChanged, out }) {
  const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  if (reload.status !== 0) {
    out.push({ what: "systemctl --user daemon-reload", status: `failed: ${(reload.stderr || "").trim()}` });
    return false;
  }
  const loaded = spawnSync("systemctl", ["--user", "is-enabled", SERVICE], { stdio: "ignore" }).status === 0;
  const active = spawnSync("systemctl", ["--user", "is-active", SERVICE], { stdio: "ignore" }).status === 0;
  if (unitChanged && active) spawnSync("systemctl", ["--user", "restart", SERVICE], { stdio: "ignore" });
  if (unitChanged || !loaded || !active) {
    const r = spawnSync("systemctl", ["--user", "enable", "--now", unitFile], { encoding: "utf8" });
    out.push({ what: "systemctl --user enable --now", status: r.status === 0 ? "wrote" : `failed: ${(r.stderr || "").trim()}` });
    return r.status === 0;
  }
  out.push({ what: "systemctl --user enable --now", status: "unchanged" });
  return true;
}

function startTmux({ supervise, out }) {
  const has = spawnSync("tmux", ["has-session", "-t", `=${TMUX_SESSION}`], { stdio: "ignore" });
  if (has.status === 0) {
    out.push({ what: `tmux session ${TMUX_SESSION}`, status: "unchanged" });
    return true;
  }
  const r = spawnSync("tmux", ["new-session", "-d", "-s", TMUX_SESSION, "-n", "daemon", supervise], { encoding: "utf8" });
  out.push({
    what: `tmux session ${TMUX_SESSION}`,
    status: r.status === 0 ? "wrote" : `failed: ${(r.stderr || r.stdout || "").trim()}`,
  });
  return r.status === 0;
}

/** Returns a list of {what, status}. status: wrote | unchanged | would write. `system:false` skips supervisors. */
export function install({ home = os.homedir(), dryRun = false, system = true, platform } = {}) {
  const pform = plat(platform);
  const cohandHome = process.env.COHAND_HOME || path.join(home, ".cohand");
  const p = plan({ home, cohandHome, node: process.execPath, platform: pform });
  const out = [];
  let plistChanged = false;
  let unitChanged = false;

  for (const f of p.files) {
    const unchanged = same(f.file, f.body);
    if (!unchanged && !dryRun) {
      fs.mkdirSync(path.dirname(f.file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(f.file, f.body, { mode: f.mode });
      fs.chmodSync(f.file, f.mode);
    }
    if (!unchanged && f.file.endsWith(".plist")) plistChanged = true;
    if (!unchanged && f.file.endsWith(SERVICE)) unitChanged = true;
    out.push({ what: f.file, status: unchanged ? "unchanged" : dryRun ? "would write" : "wrote" });
  }

  let linkOk = false;
  try { linkOk = fs.readlinkSync(p.link.from) === p.link.to; } catch {}
  if (!linkOk && !dryRun) {
    fs.mkdirSync(path.dirname(p.link.from), { recursive: true });
    try { fs.unlinkSync(p.link.from); } catch {}
    fs.symlinkSync(p.link.to, p.link.from);
    fs.chmodSync(p.link.to, 0o755);
  }
  out.push({ what: p.link.from, status: linkOk ? "unchanged" : dryRun ? "would write" : "wrote" });

  if (system && !dryRun) {
    if (pform === "darwin") {
      startLaunchd({ uid: process.getuid(), plistFile: p.plist, plistChanged, out });
    } else if (pform === "linux") {
      if (systemdUserWorks()) {
        startSystemdUser({ unitFile: p.systemdUnit, unitChanged, out });
      } else {
        startTmux({ supervise: p.supervise, out });
      }
    }
  }
  return out;
}

export async function run(argv) {
  const dryRun = argv.includes("--dry-run");
  const res = install({ dryRun });
  for (const r of res) console.log(`${r.status.padEnd(12)} ${r.what}`);
  const failed = res.some((r) => r.status.startsWith("failed"));
  if (!dryRun && !failed) console.log("\nnext: in each Chrome profile, Load unpacked -> " + path.join(ROOT, "extension") + ", then name the profile in the popup. Check with `cohand doctor`.");
  return failed ? 1 : 0;
}
