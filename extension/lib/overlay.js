// cohand — overlay bookkeeping (pure). Which commands show what, whether the overlay is on,
// and which tabs are still "active" so a new page after navigation gets the glow again.

export const GLOW_MS = 5 * 60_000; // glow stays for the session; session end clears it, this is the crash fallback
export const SETTLE_MS = 300; // wait after showing the move, before acting

const MODES = {
  click: "click", hover: "move", drag: "move",
  type: "box", select: "box", upload: "box",
  scroll: "point",
  open: "glow", back: "glow", forward: "glow", reload: "glow", key: "glow",
};
const PRE_ACTION = new Set(["click", "hover", "drag", "type", "select", "upload", "scroll"]);

/** Overlay style for a command, or null for commands that don't show anything. */
export const modeFor = (cmd) => MODES[cmd] ?? null;

/** Show the move first and wait before acting? (Navigation/key only glow, after the fact.) */
export const isPreAction = (cmd) => PRE_ACTION.has(cmd);

/** On by default; off with --no-show (args.noShow) or COHAND_NO_SHOW=1. */
export const overlayEnabled = (args) => !args?.noShow;

/** Tabs with a live glow window. */
export function createTracker(now = () => Date.now()) {
  const until = new Map();
  return {
    touch(tabId) { until.set(tabId, now() + GLOW_MS); },
    remaining(tabId) { return Math.max(0, (until.get(tabId) ?? 0) - now()); },
    isActive(tabId) { return (until.get(tabId) ?? 0) > now(); },
    clear(tabId) { until.delete(tabId); },
  };
}

/** Where the cursor goes for a command, as an overlay message. */
export function overlayPayload(cmd, mode, a) {
  const p = { mode, glowMs: GLOW_MS };
  const ref = a.ref;
  if (typeof a.x === "number" && typeof a.y === "number") return { ...p, x: a.x, y: a.y };
  if (typeof ref === "string" && /^\d+,\d+$/.test(ref)) { const [x, y] = ref.split(",").map(Number); return { ...p, x, y }; }
  return ref ? { ...p, ref } : p;
}
