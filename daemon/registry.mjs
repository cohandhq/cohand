// State: connected profiles (one host connection each) and sessions, persisted across daemon restarts.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class Registry {
  /**
   * @param {{sessionsFile?: string}} [opts] when sessionsFile is given, sessions are persisted there
   *   and reloaded on construction so a restarted daemon keeps existing ids/pins.
   */
  constructor(opts = {}) {
    this.profiles = new Map(); // name -> host {name, send(frame), pending:Map, close()}
    this.sessions = new Map(); // id -> {id, name, profile}
    this.focusAt = new Map(); // profile name -> tick of last focused:true
    this.focused = new Map(); // profile name -> bool (window of that profile focused now)
    this.tick = 0;
    this.asks = new Map(); // askId -> {id, profile, summary, at}
    this.sessionsFile = opts.sessionsFile || null;
    this.load();
  }
  /** Reload persisted {id,name,profile} rows; a corrupt file is set aside instead of crashing the daemon. */
  load() {
    if (!this.sessionsFile || !fs.existsSync(this.sessionsFile)) return;
    let rows;
    try {
      rows = JSON.parse(fs.readFileSync(this.sessionsFile, "utf8"));
      if (!Array.isArray(rows)) throw new Error("sessions file is not a JSON array");
    } catch {
      try { fs.renameSync(this.sessionsFile, `${this.sessionsFile}.corrupt`); } catch {}
      return;
    }
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!id || !name) continue;
      const profile = typeof row.profile === "string" && row.profile ? row.profile : null;
      this.sessions.set(id, { id, name, profile });
    }
  }
  /** Persist sessions atomically (0600, temp file in the same dir + rename) so a restart can resume them. */
  save() {
    if (!this.sessionsFile) return;
    const dir = path.dirname(this.sessionsFile);
    const tmp = `${this.sessionsFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const rows = this.listSessions().map(({ id, name, profile }) => ({ id, name, profile: profile ?? null }));
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(tmp, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.sessionsFile);
    } catch {
      // Losing the write must not take the daemon down; sessions still work for this run.
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  markFocus(name, focused) {
    this.focused.set(name, !!focused);
    if (focused) this.focusAt.set(name, ++this.tick);
  }
  /** Front profile: connected profile focused most recently (else the latest to connect). */
  front() {
    let best = null, bestAt = -1;
    for (const [name, h] of this.profiles) {
      const at = this.focusAt.get(name) ?? -1;
      if (best === null || at > bestAt || (at === bestAt && h.seq > this.profiles.get(best).seq)) { best = name; bestAt = at; }
    }
    return best;
  }
  addProfile(host) {
    const old = this.profiles.get(host.name);
    host.seq = ++this.tick;
    this.profiles.set(host.name, host);
    return old;
  }
  removeProfile(host) {
    if (this.profiles.get(host.name) === host) this.profiles.delete(host.name);
  }
  names() { return [...this.profiles.keys()].sort(); }
  startSession(name, profile) {
    const id = randomBytes(4).toString("hex");
    const s = { id, name, profile: profile || null };
    this.sessions.set(id, s);
    this.save();
    return s;
  }
  resumeSession(id) {
    const s = this.sessions.get(String(id));
    if (!s) throw new Error("unknown session — it may have ended or the daemon restarted");
    if (s.profile && !this.profiles.has(s.profile)) {
      throw new Error(`session "${s.name}" is pinned to profile ${s.profile}, which is not connected — reopen that Chrome profile, or run: cohand session start <name> --profile <connected>`);
    }
    return s;
  }
  endSession(id) {
    const ended = this.sessions.delete(id);
    this.save();
    return ended;
  }
  listSessions() { return [...this.sessions.values()]; }
  /** Pick a profile name: explicit → session's pin → front profile → error. */
  choose(explicit, session) {
    if (explicit) {
      if (!this.profiles.has(explicit)) throw new Error(`profile ${explicit} is not connected (connected: ${this.names().join(", ") || "none"})`);
      return explicit;
    }
    if (session?.profile) {
      if (!this.profiles.has(session.profile)) throw new Error(`profile ${session.profile} disconnected — reopen it or start a new session`);
      return session.profile;
    }
    const f = this.front();
    if (!f) throw new Error("no Chrome profile connected — load the cohand extension in a profile");
    return f;
  }
}
