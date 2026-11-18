import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { install, extensionId, HOST_NAME, SERVICE, nativeMessagingDirs, chromeUserDataDirs, looksLikeUserDataDir } from "../cli/install.mjs";
import { checks } from "../cli/doctor.mjs";
import { startDaemon } from "../daemon/server.mjs";
import { tmpHome } from "./helpers.mjs";

const P = (home, ...r) => path.join(home, ...r);

/** Realistic user-data dir: Chrome marks it with a `Local State` file at the root. */
const mkUserDataDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Local State"), "{}");
};

/**
 * The live `~/chrome-profile` layout: the root is a user-data dir, Fork-* are child
 * profiles, and Default/Dictionaries/NativeMessagingHosts are Chrome internals.
 */
function fakeProfileTree(home) {
  const root = P(home, "chrome-profile");
  mkUserDataDir(root);
  mkUserDataDir(P(root, "Fork-5"));
  mkUserDataDir(P(root, "Fork-2"));
  fs.mkdirSync(P(root, "Default"), { recursive: true });
  fs.mkdirSync(P(root, "Dictionaries"), { recursive: true });
  fs.mkdirSync(P(root, "NativeMessagingHosts", "NativeMessagingHosts"), { recursive: true });
  return root;
}

test("install writes plist + manifest into a temp HOME; second run changes nothing", () => {
  const home = tmpHome();
  fs.mkdirSync(P(home, ".claude"));
  process.env.COHAND_HOME = P(home, ".cohand");
  try {
    const first = install({ home, system: false, platform: "darwin" });
    assert.ok(first.some((r) => r.status === "wrote"));
    const plist = fs.readFileSync(P(home, "Library/LaunchAgents/com.cohand.daemon.plist"), "utf8");
    assert.match(plist, /KeepAlive/);
    assert.match(plist, /RunAtLoad/);
    const m = JSON.parse(fs.readFileSync(P(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.cohand.host.json"), "utf8"));
    assert.deepEqual(m.allowed_origins, [`chrome-extension://${extensionId()}/`]);
    assert.ok(fs.statSync(m.path).mode & 0o100, "launcher is executable");
    assert.ok(fs.existsSync(P(home, ".claude/skills/cohand/SKILL.md")));
    assert.ok(!fs.existsSync(P(home, ".codex")), "no skill dir where agent is absent");
    assert.equal(fs.readlinkSync(P(home, ".local/bin/cohand")).endsWith("cli/cohand.mjs"), true);
    const second = install({ home, system: false, platform: "darwin" });
    assert.ok(second.every((r) => r.status === "unchanged"), JSON.stringify(second));
  } finally { delete process.env.COHAND_HOME; }
});

test("linux install writes systemd unit, supervise script, and Chrome user-data-dir manifests", () => {
  const home = tmpHome();
  fs.mkdirSync(P(home, ".codex"));
  fs.mkdirSync(P(home, ".grok"));
  fs.mkdirSync(P(home, ".cursor"));
  const profileRoot = fakeProfileTree(home);
  process.env.COHAND_HOME = P(home, ".cohand");
  try {
    const first = install({ home, system: false, platform: "linux" });
    assert.ok(first.some((r) => r.status === "wrote"));
    assert.ok(!fs.existsSync(P(home, "Library/LaunchAgents/com.cohand.daemon.plist")), "does not write launchd plist on Linux");

    const unit = fs.readFileSync(P(home, ".config/systemd/user", SERVICE), "utf8");
    assert.match(unit, /\[Service\]/);
    assert.match(unit, /Restart=always/);
    assert.match(unit, /daemon\/main\.mjs/);

    const supervise = P(home, ".cohand/supervise-daemon.sh");
    assert.ok(fs.statSync(supervise).mode & 0o100, "supervise script is executable");
    const body = fs.readFileSync(supervise, "utf8");
    assert.match(body, /while true/);
    assert.match(body, /restarting in 2s/);

    const wantDirs = nativeMessagingDirs(home, { platform: "linux", scanProc: false });
    assert.ok(wantDirs.some((d) => d.endsWith(path.join(".config", "google-chrome", "NativeMessagingHosts"))));
    assert.ok(wantDirs.some((d) => d.endsWith(path.join("chrome-profile", "NativeMessagingHosts"))), "root profile included");
    assert.ok(wantDirs.some((d) => d.endsWith(path.join("chrome-profile", "Fork-5", "NativeMessagingHosts"))));
    assert.ok(wantDirs.some((d) => d.endsWith(path.join("chrome-profile", "Fork-2", "NativeMessagingHosts"))));
    for (const internal of ["Default", "Dictionaries", path.join("NativeMessagingHosts", "NativeMessagingHosts")]) {
      const nm = P(profileRoot, internal, "NativeMessagingHosts");
      assert.ok(!wantDirs.includes(nm), `internal dir ${internal} is not planned`);
      assert.ok(!fs.existsSync(nm), `nothing written into internal dir ${internal}`);
    }
    for (const d of wantDirs) {
      const m = JSON.parse(fs.readFileSync(path.join(d, HOST_NAME + ".json"), "utf8"));
      assert.deepEqual(m.allowed_origins, [`chrome-extension://${extensionId()}/`]);
      assert.equal(m.name, HOST_NAME);
      assert.ok(fs.statSync(m.path).mode & 0o100, "launcher is executable");
    }

    assert.ok(fs.existsSync(P(home, ".codex/skills/cohand/SKILL.md")));
    assert.ok(fs.existsSync(P(home, ".grok/skills/cohand/SKILL.md")));
    assert.ok(fs.existsSync(P(home, ".cursor/skills/cohand/SKILL.md")));
    assert.ok(fs.existsSync(P(home, ".agents/skills/cohand/SKILL.md")), "shared Agent Skills dir always gets the skill");
    assert.ok(!fs.existsSync(P(home, ".kiro")), "no skill dir where agent is absent");
    assert.ok(!fs.existsSync(P(home, ".claude")), "no skill dir where agent is absent");
    assert.equal(fs.readlinkSync(P(home, ".local/bin/cohand")).endsWith("cli/cohand.mjs"), true);

    const second = install({ home, system: false, platform: "linux" });
    assert.ok(second.every((r) => r.status === "unchanged"), JSON.stringify(second));
  } finally { delete process.env.COHAND_HOME; }
});

test("looksLikeUserDataDir and chromeUserDataDirs only accept dirs with Local State", () => {
  const home = tmpHome();
  const root = fakeProfileTree(home);
  assert.equal(looksLikeUserDataDir(root), true);
  assert.equal(looksLikeUserDataDir(P(root, "Fork-5")), true);
  assert.equal(looksLikeUserDataDir(P(root, "Default")), false);
  assert.equal(looksLikeUserDataDir(P(root, "Dictionaries")), false);
  assert.equal(looksLikeUserDataDir(P(root, "does-not-exist")), false);

  const dirs = chromeUserDataDirs(home, { platform: "linux", scanProc: false });
  assert.ok(dirs.includes(P(home, ".config/google-chrome")), "default Chrome dir kept");
  assert.ok(dirs.includes(root), "custom root kept");
  assert.ok(dirs.includes(P(root, "Fork-5")));
  assert.ok(dirs.includes(P(root, "Fork-2")));
  for (const bad of ["Default", "Dictionaries", path.join("NativeMessagingHosts", "NativeMessagingHosts")]) {
    assert.ok(!dirs.some((d) => d === P(root, bad)), `internal dir ${bad} excluded`);
  }
});

test("doctor only reports missing manifests for real user-data dirs", async () => {
  const home = tmpHome();
  const root = fakeProfileTree(home);
  process.env.COHAND_HOME = P(home, ".cohand");
  try {
    // Nothing installed yet: the report must not count the internal dirs as profiles.
    const before = await checks({ home, platform: "linux" });
    const missingLine = before.find((r) => /host manifest missing/.test(r.msg));
    assert.ok(missingLine, JSON.stringify(before));
    assert.equal(missingLine.ok, false);
    assert.doesNotMatch(missingLine.msg, /profile\(s\)/, "primary manifest missing, not a per-profile count");

    install({ home, system: false, platform: "linux" });
    for (const internal of ["Default", "Dictionaries", path.join("NativeMessagingHosts", "NativeMessagingHosts")]) {
      assert.ok(!fs.existsSync(P(root, internal, "NativeMessagingHosts", HOST_NAME + ".json")),
        `no manifest in internal dir ${internal}`);
    }
    const after = await checks({ home, platform: "linux" });
    assert.ok(!after.some((r) => /host manifest missing/.test(r.msg)), JSON.stringify(after));
    assert.ok(after.some((r) => r.ok && /host manifest installed/.test(r.msg)), JSON.stringify(after));
    // No daemon here: failures must be limited to daemon/profile checks.
    assert.ok(after.filter((r) => !r.ok).every((r) => /daemon|socket|profile/.test(r.msg)), JSON.stringify(after));
  } finally { delete process.env.COHAND_HOME; }
});

test("doctor does not show socket permissions as ok for a stale socket file", async () => {
  const home = tmpHome();
  const cohandHome = P(home, ".cohand");
  process.env.COHAND_HOME = cohandHome;
  try {
    fs.mkdirSync(cohandHome, { recursive: true });
    const sock = P(cohandHome, "cohandd.sock");
    fs.writeFileSync(sock, "");
    fs.chmodSync(sock, 0o600);
    const res = await checks({ home, platform: "linux" });
    assert.ok(!res.some((r) => r.ok && /socket permissions/.test(r.msg)), JSON.stringify(res));
    const stale = res.find((r) => /stale socket file/.test(r.msg));
    assert.ok(stale, JSON.stringify(res));
    assert.equal(stale.ok, false);
  } finally { delete process.env.COHAND_HOME; }
});

test("dry-run writes nothing", () => {
  const home = tmpHome();
  process.env.COHAND_HOME = P(home, ".cohand");
  try {
    const r = install({ home, dryRun: true, platform: "linux" });
    assert.ok(r.every((x) => x.status !== "wrote"));
    assert.deepEqual(fs.readdirSync(home), []);
    const mac = install({ home, dryRun: true, platform: "darwin" });
    assert.ok(mac.every((x) => x.status !== "wrote"));
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { delete process.env.COHAND_HOME; }
});

test("doctor reports ok after install with a running daemon", async () => {
  const home = tmpHome();
  process.env.COHAND_HOME = P(home, ".cohand");
  try {
    install({ home, system: false, platform: "linux" });
    const d = await startDaemon({ home: P(home, ".cohand") });
    const res = await checks({ home, platform: "linux" });
    assert.ok(res.filter((r) => !r.ok).map((r) => r.msg).every((m) => /no profile connected/.test(m)), JSON.stringify(res));
    await d.close();
    const down = await checks({ home, platform: "linux" });
    assert.equal(down[0].ok, false);
  } finally { delete process.env.COHAND_HOME; }
});
