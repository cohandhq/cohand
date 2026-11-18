// cohand pi adapter — browser_* tool definitions. Runner-agnostic: index.ts maps these onto
// pi's registerTool (TypeBox); tests drive them with a fake cohandd client.

import fs from "node:fs";
import path from "node:path";
import { paths } from "../../daemon/paths.mjs";

const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Private scratch dir shared with the CLI: COHAND_TMP when set, else <COHAND_HOME>/tmp. */
export function screenshotDir() {
  return process.env.COHAND_TMP || paths().tmp;
}

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

const PROFILE_ARG = {
  name: "profile",
  type: "string",
  required: false,
  description: "Connected browser profile to target (see browser_status). Default: most recently active.",
};

function trunc(s, n = 15000) {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  return str.slice(0, n) + `\n…[truncated ${n}/${str.length} chars — narrow scope: use a selector, snapshot sections, or read the page in parts]`;
}

async function send(client, profile, op, args) {
  const data = await client.request(op, args, profile ? { profile } : undefined);
  return data ?? {};
}

export const TOOLS = [
  {
    name: "browser_status",
    description: "Show which browser profiles are connected to cohand, plus screenshot dir. Start here when a browser tool fails.",
    args: [],
    run: async (client) => {
      const profiles = (await client.request("profiles", {})) || [];
      const head = profiles.length
        ? `connected profiles: ${profiles.join(", ")}`
        : "no browser profiles connected — load the cohand extension in a Chrome profile (run `cohand doctor`)";
      return { content: `${head}\nscreenshots: ${screenshotDir()}` };
    },
  },
  {
    name: "browser_open",
    description: "Open a URL in the connected browser. Opens inside this pi session's own tab group. Reuses the group's tab by default, or a new tab.",
    args: [
      { name: "url", type: "string", required: true, description: "http(s) URL to open" },
      { name: "newTab", type: "boolean", required: false, description: "Open in a new tab instead of the active one" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      const d = await send(client, a.profile, "open", { url: a.url, newTab: !!a.newTab });
      return { content: `opened ${d.url || a.url}${d.title ? ` — "${trunc(d.title, 200)}"` : ""} (tab ${d.tabId ?? "?"})` };
    },
  },
  {
    name: "browser_tabs",
    description: "List open tabs in the connected browser profile (tabId, title, URL, active, group).",
    args: [PROFILE_ARG],
    run: async (client, a) => {
      const d = await send(client, a.profile, "tabs", {});
      const lines = (d.tabs || []).map((t) =>
        `${t.active ? "*" : " "} ${t.tabId}${t.group ? ` [${t.group}]` : ""} ${trunc(t.title || "", 80)} — ${trunc(t.url || "", 120)}`);
      return { content: lines.join("\n") || "no tabs open", structured: d.tabs };
    },
  },
  {
    name: "browser_activate",
    description: "Make a tab active (bring to front) by tabId from browser_tabs.",
    args: [{ name: "tabId", type: "number", required: true, description: "tabId to activate" }, PROFILE_ARG],
    run: async (client, a) => {
      const d = await send(client, a.profile, "activate", { tabId: a.tabId });
      return { content: `active tab ${d.tabId ?? a.tabId}${d.title ? ` — "${trunc(d.title, 120)}"` : ""}` };
    },
  },
  {
    name: "browser_close",
    description: "Close a tab by tabId.",
    args: [{ name: "tabId", type: "number", required: true, description: "tabId to close" }, PROFILE_ARG],
    run: async (client, a) => {
      await send(client, a.profile, "close", { tabId: a.tabId });
      return { content: `closed tab ${a.tabId}` };
    },
  },
  {
    name: "browser_snapshot",
    description: "Capture an accessibility-style snapshot of the active tab: page structure as text with element refs (e1, e2, …) for click/type/select. Call after navigation or when refs go stale.",
    args: [PROFILE_ARG],
    run: async (client, a) => {
      const d = await send(client, a.profile, "snapshot", {});
      return { content: trunc(d.text, 15000), structured: { url: d.url, title: d.title } };
    },
  },
  {
    name: "browser_get_text",
    description: "Get visible text of the active tab, optionally only inside a CSS selector.",
    args: [
      { name: "selector", type: "string", required: false, description: "CSS selector to scope extraction" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      const d = await send(client, a.profile, "text", { selector: a.selector });
      return { content: trunc(d.text, 15000) || "(no text)", structured: { url: d.url } };
    },
  },
  {
    name: "browser_click",
    description: "Click an element by its ref from browser_snapshot.",
    args: [{ name: "ref", type: "string", required: true, description: "element ref, e.g. e12" }, PROFILE_ARG],
    run: async (client, a) => {
      const d = await send(client, a.profile, "click", { ref: a.ref });
      return { content: `clicked ${a.ref}${d.after ? ` → ${trunc(d.after, 300)}` : ""}` };
    },
  },
  {
    name: "browser_type",
    description: "Type text into an input by ref (replaces content). Set submit:true to press Enter after.",
    args: [
      { name: "ref", type: "string", required: true, description: "element ref of the input" },
      { name: "text", type: "string", required: true, description: "text to type" },
      { name: "submit", type: "boolean", required: false, description: "press Enter after typing" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      await send(client, a.profile, "type", { ref: a.ref, text: a.text, submit: !!a.submit });
      return { content: `typed into ${a.ref}${a.submit ? " and pressed Enter" : ""}` };
    },
  },
  {
    name: "browser_press",
    description: "Press a key on the active tab (e.g. Enter, Escape, Tab, ArrowDown).",
    args: [{ name: "key", type: "string", required: true, description: "key name" }, PROFILE_ARG],
    run: async (client, a) => {
      await send(client, a.profile, "key", { combo: a.key });
      return { content: `pressed ${a.key}` };
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the active tab up or down by pixels (default 600).",
    args: [
      { name: "direction", type: "string", required: false, enum: ["up", "down"], description: "scroll direction (default down)" },
      { name: "amount", type: "number", required: false, description: "pixels (default 600)" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      const d = await send(client, a.profile, "scroll", { direction: a.direction || "down", amount: a.amount || 600 });
      return { content: `scrolled — page at ${d.scrollY ?? "?"}px of ${d.scrollHeight ?? "?"}px` };
    },
  },
  {
    name: "browser_select",
    description: "Choose an option in a <select> dropdown by element ref.",
    args: [
      { name: "ref", type: "string", required: true, description: "element ref of the select" },
      { name: "value", type: "string", required: true, description: "option value or visible text" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      await send(client, a.profile, "select", { ref: a.ref, value: a.value });
      return { content: `selected "${a.value}" in ${a.ref}` };
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait until text appears on the page or a CSS selector matches (max 15s).",
    args: [
      { name: "text", type: "string", required: false, description: "text to wait for" },
      { name: "selector", type: "string", required: false, description: "CSS selector to wait for" },
      { name: "timeoutMs", type: "number", required: false, description: "max wait in ms (default 10000, max 15000)" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      const d = await send(client, a.profile, "wait", { text: a.text, selector: a.selector, timeoutMs: Math.min(a.timeoutMs || 10000, 15000) });
      return { content: d.found ? `found ${a.selector || `"${a.text}"`} after ${d.elapsedMs ?? "?"}ms` : `timed out waiting for ${a.selector || `"${a.text}"`}` };
    },
  },
  {
    name: "browser_screenshot",
    description: "Screenshot the active tab (viewport, or full page with fullPage:true). Saved as PNG; read the returned file path with the read tool to view it.",
    args: [
      { name: "fullPage", type: "boolean", required: false, description: "capture the whole scrollable page" },
      PROFILE_ARG,
    ],
    run: async (client, a) => {
      const d = await send(client, a.profile, "screenshot", { full: !!a.fullPage });
      const file = saveScreenshot(d.dataUrl);
      const size = `${d.width ?? "?"}x${d.height ?? "?"}`;
      return { content: `saved screenshot ${size} → ${file} (view it: read "${file}")`, structured: { path: file, width: d.width, height: d.height } };
    },
  },
  {
    name: "browser_cookies",
    description: "List cookie names for a URL in the connected profile (values are never returned).",
    args: [{ name: "url", type: "string", required: true, description: "URL whose cookies to list" }, PROFILE_ARG],
    run: async (client, a) => {
      const d = await send(client, a.profile, "cookies", { url: a.url });
      const lines = (d.cookies || []).map((c) => `${c.name} (${c.domain}${c.httpOnly ? ", httpOnly" : ""})`);
      return { content: trunc(lines.join("\n"), 8000) || "no cookies", structured: d.cookies };
    },
  },
  {
    name: "browser_downloads",
    description: "List recent downloads in the connected profile (state, filename, URL).",
    args: [PROFILE_ARG],
    run: async (client, a) => {
      const d = await send(client, a.profile, "downloads", {});
      const lines = (d.downloads || []).map((x) => `${x.state} ${x.filename} — ${trunc(x.url, 100)}`);
      return { content: trunc(lines.join("\n"), 8000) || "no downloads", structured: d.downloads };
    },
  },
];

export function getTool(name) {
  return TOOLS.find((t) => t.name === name);
}

function coerce(value, type, name) {
  if (type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${name} must be a boolean`);
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function validateArgs(toolName, args) {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`unknown tool ${toolName}`);
  const out = {};
  const known = new Set(tool.args.map((a) => a.name));
  for (const [k, v] of Object.entries(args || {})) {
    if (!known.has(k)) throw new Error(`unknown argument "${k}" for ${toolName}`);
  }
  for (const a of tool.args) {
    const v = (args || {})[a.name];
    if (v === undefined || v === null) {
      if (a.required) throw new Error(`${toolName}: missing required argument "${a.name}"`);
      continue;
    }
    const cv = coerce(v, a.type, `${toolName}: ${a.name}`);
    if (a.enum && !a.enum.includes(cv)) throw new Error(`${toolName}: ${a.name} must be one of ${a.enum.join("|")}`);
    out[a.name] = cv;
  }
  if (toolName === "browser_open") {
    const u = out.url;
    if (!/^https?:\/\//i.test(u)) throw new Error("browser_open: url must start with http:// or https://");
  }
  if (toolName === "browser_wait_for" && !out.text && !out.selector) {
    throw new Error("browser_wait_for: provide text or selector");
  }
  return out;
}

export function saveScreenshot(dataUrl) {
  if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
    throw new Error("screenshot failed: extension returned non-image data");
  }
  const dir = screenshotDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  pruneTmpDir(dir);
  const ext = dataUrl.startsWith("data:image/jpeg") ? "jpg" : "png";
  const name = `shot-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  return file;
}
