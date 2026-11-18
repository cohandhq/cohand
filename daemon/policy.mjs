// Policy: kill switch, site rules, ask-first. Pure functions + a tiny file loader.
import fs from "node:fs";
import path from "node:path";

// Banks: explicit major domains rather than a "*.bank*" wildcard, which missed bare
// hosts and caught unrelated names like bankruptcy.com. "*.bank" is the .bank TLD.
export const BUILTIN_BANKS = [
  "*.bank",
  "bankofamerica.com", "chase.com", "citi.com", "usbank.com", "wellsfargo.com",
  "capitalone.com", "pnc.com", "ally.com", "hsbc.com", "barclays.co.uk",
  "santander.com", "truist.com", "regions.com", "citizensbank.com",
  "huntington.com", "bmo.com", "scotiabank.com", "commbank.com.au", "westpac.com.au",
];

export const BUILTIN_BLOCK = [
  ...BUILTIN_BANKS,
  // Payments, password managers, Google account security.
  "paypal.com", "stripe.com/dashboard", "accounts.google.com/*security*",
  "1password.com", "bitwarden.com", "lastpass.com",
];

export function defaultPolicy() {
  return { off: false, profiles: {}, defaults: { block: [...BUILTIN_BLOCK], askFirst: false } };
}

/** Replace the legacy "*.bank*" rule (kept in existing policy files) with the explicit list. */
function migrateBlock(block) {
  if (!Array.isArray(block) || !block.includes("*.bank*")) return block;
  const out = block.flatMap((p) => (p === "*.bank*" ? BUILTIN_BANKS : [p]));
  return [...new Set(out)];
}

export function loadPolicy(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(defaultPolicy(), null, 2) + "\n", { mode: 0o600 });
  }
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  const d = defaultPolicy();
  const policy = { ...d, ...p, defaults: { ...d.defaults, ...(p.defaults || {}) }, profiles: p.profiles || {} };
  const migrated = migrateBlock(policy.defaults.block);
  if (migrated !== policy.defaults.block) {
    policy.defaults.block = migrated;
    savePolicy(file, policy);
  }
  return policy;
}

export function savePolicy(file, policy) {
  fs.writeFileSync(file, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
}

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

/** Does url match a domain pattern? Host-only patterns match the host and its subdomains;
 *  patterns with a path match host+path as a prefix. */
export function matches(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const p = String(pattern).toLowerCase(); // hostnames are lowercased; hand-edited patterns may not be
  const hostPath = u.hostname + u.pathname;
  if (p.includes("/")) return new RegExp("^(.*\\.)?" + esc(p)).test(hostPath);
  return new RegExp("^(.*\\.)?" + esc(p) + "$").test(u.hostname);
}

const RISKY_KEY = /enter|return/i;

export function check(policy, { profile, op, url, args = {} }) {
  const pc = policy.profiles?.[profile] || {};
  if (policy.off) return { verdict: "deny", reason: "cohand is switched off" };
  if (pc.off) return { verdict: "deny", reason: `cohand is switched off for ${profile}` };
  if (args.anyTab && !pc.anyTab) return { verdict: "deny", reason: `--any-tab is not allowed for ${profile}` };
  if (url) {
    const allow = pc.allow || [];
    const allowed = allow.some((p) => matches(p, url));
    const blocked = (pc.block || []).some((p) => matches(p, url)) ||
      (!allowed && (policy.defaults?.block || []).some((p) => matches(p, url)));
    if (blocked) return { verdict: "deny", reason: `site blocked by policy: ${new URL(url).hostname}` };
  }
  const askFirst = pc.askFirst ?? policy.defaults?.askFirst ?? false;
  if (askFirst) {
    if (op === "upload" || op === "eval") return { verdict: "ask", reason: `${op} needs approval` };
    const risky = args.risky === true;
    if (risky && (op === "click" || (op === "key" && RISKY_KEY.test(String(args.combo ?? args.key ?? ""))) || (op === "type" && args.submit))) {
      return { verdict: "ask", reason: "risky action needs approval" };
    }
  }
  return { verdict: "allow", reason: "" };
}

/** Add/remove a domain in one profile's block list (mutates policy). */
export function setBlock(policy, profile, domain, on) {
  const d = String(domain || "").trim().toLowerCase();
  if (!/^[a-z0-9*][a-z0-9.*-]*$/.test(d)) throw new Error(`invalid domain: ${domain}`);
  const pc = (policy.profiles[profile] = { ...(policy.profiles[profile] || {}) });
  const list = new Set(pc.block || []);
  if (on) list.add(d); else list.delete(d);
  pc.block = [...list];
  return pc.block;
}
