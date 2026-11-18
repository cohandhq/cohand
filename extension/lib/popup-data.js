// Pure helpers for the popup: formatting and view-model shaping. No chrome.* here.

export function timeAgo(iso, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function domainOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch { return null; }
}

/** Is this domain covered by the block list (entry equals it or is a parent domain)? */
export function isBlocked(domain, list) {
  return (list || []).some((d) => domain === d || domain.endsWith("." + d));
}

export function statusView({ enabled, connected, front }) {
  if (!enabled) return { label: "Off", dot: "off" };
  if (!connected) return { label: "Connecting…", dot: "standby" };
  return front ? { label: "Active (front)", dot: "on" } : { label: "Standby", dot: "standby" };
}

/** Newest first, at most 20. Accepts entries in any order. */
export function shapeRecent(entries, now = Date.now()) {
  return [...(entries || [])].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 20).map((e) => row(e, now));
}

function row(e, now) {
  return { time: timeAgo(e.t, now), session: e.session || "—", action: e.op, status: e.result === "ok" ? "ok" : e.result === "denied" ? "denied" : "error" };
}
