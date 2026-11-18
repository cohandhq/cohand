// Chrome error pages look like ordinary completed tabs, so every command against one
// surfaces the same opaque injection failure. Turn that into something an agent can act on.
// See docs/ISSUES.md #31 (the box's browser sandbox blocks loopback HTTP).

const ERROR_PAGE_PATTERNS = [/showing error page/i, /chrome-error/i, /ERR_[A-Z_]+/];

/** True when Chrome's message means the tab is (or was about to become) an error page. */
export function isPageErrorMessage(message) {
  const text = String(message ?? "");
  return ERROR_PAGE_PATTERNS.some((re) => re.test(text));
}

const hostOf = (url) => {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try { return new URL(candidate).hostname.toLowerCase(); } catch { return ""; }
};

const isLoopbackHost = (host) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  /^127(?:\.\d{1,3}){3}$/.test(host) ||
  host === "[::1]" ||
  host === "::1";

const isPrivateLanHost = (host) =>
  /^10(?:\.\d{1,3}){3}$/.test(host) ||
  /^192\.168(?:\.\d{1,3}){2}$/.test(host) ||
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host) ||
  /^169\.254(?:\.\d{1,3}){2}$/.test(host) ||
  host.endsWith(".local");

/** A local dev URL (loopback or private LAN) that this browser sandbox cannot reach over HTTP. */
export function isLocalUrl(url) {
  const host = hostOf(url);
  return !!host && (isLoopbackHost(host) || isPrivateLanHost(host));
}

/** Rewrite Chrome's error-page failure into an actionable message; leave anything else alone. */
export function describePageError(message, url) {
  const original = String(message ?? "");
  if (!isPageErrorMessage(original)) return original;
  const target = String(url ?? "").trim();
  const where = target ? target : "the requested page";
  if (target && isLocalUrl(target)) {
    return `Chrome could not load ${where} — this browser sandbox blocks loopback HTTP (localhost, 127.0.0.1, [::1], private LAN) and only HTTPS egress works. Run \`cloudflared tunnel --url ${target}\` and open the https URL instead (docs/ISSUES.md #31). Chrome said: ${original}`;
  }
  return `Chrome could not load ${where} — the browser reached an error page instead of the site; check the URL and network access. If this is a local URL, this sandbox blocks loopback HTTP and only HTTPS egress works — use an HTTPS tunnel such as \`cloudflared tunnel --url <url>\` (docs/ISSUES.md #31). Chrome said: ${original}`;
}
