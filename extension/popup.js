// cohand popup — renders the status the background fetched from the daemon.
import { timeAgo, domainOf, isBlocked, statusView, shapeRecent } from "./lib/popup-data.js";

const $ = (id) => document.getElementById(id);
// No reply (background waking up / just reloaded) resolves undefined; treat it as an error, not a crash.
const bg = (m) => chrome.runtime.sendMessage(m)
  .then((r) => r ?? { ok: false, error: "cohand is starting — try again in a moment" })
  .catch((e) => ({ ok: false, error: e.message }));
let domain = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, cls, onClick) {
  const b = el("button", cls, label);
  b.addEventListener("click", async () => { b.disabled = true; await onClick(); refresh(); });
  return b;
}

async function refresh() {
  const res = await bg({ popup: "status" });
  const st = res.ok ? res.data : { enabled: true, connected: false, front: false, error: res.error };
  const view = statusView(st);
  $("dot").className = "dot " + (view.dot === "standby" ? "" : view.dot);
  $("state").textContent = view.label;
  $("err").textContent = st.error && st.enabled ? st.error : "";

  const { profileLabel } = await chrome.storage.local.get({ profileLabel: "" });
  if (document.activeElement !== $("profile")) $("profile").value = profileLabel || st.profile || "";

  const agents = $("agents"); agents.textContent = "";
  for (const s of st.sessions || []) {
    const card = el("div", "agent");
    const info = el("div", "grow");
    card.append(el("span", "live-dot"));
    info.append(el("div", "name", s.name), el("div", "sub", s.lastAction ? `${s.lastAction} · ${timeAgo(s.lastAt)}` : "no actions yet"));
    card.append(info, button("Stop", "stop", () => bg({ popup: "call", op: "session.end", args: { session: s.id } })));
    agents.append(card);
  }
  if (!(st.sessions || []).length) agents.append(el("div", "empty", "No agents working right now."));

  const asks = (st.pending || []).length ? st.pending : (st.asks || []);
  $("askSec").hidden = !asks.length;
  const askBox = $("asks"); askBox.textContent = "";
  for (const a of asks) {
    const card = el("div", "card");
    const info = el("div", "grow"); info.append(el("div", "", a.summary));
    const answer = (allow) => () => bg({ popup: "ask", id: a.id, allow });
    card.append(info, button("Allow", "allow", answer(true)), button("Deny", "deny", answer(false)));
    askBox.append(card);
  }

  $("siteSec").hidden = !domain;
  if (domain) {
    $("block").checked = isBlocked(domain, st.block);
    $("block").disabled = !st.connected;
    $("blockLabel").textContent = `Block Cohand on ${domain}`;
  }

  $("anyTab").checked = st.anyTab === true;
  $("anyTab").disabled = !st.connected;

  const recent = $("recent"); recent.textContent = "";
  const rows = shapeRecent(st.recent).slice(0, 6);
  const multi = new Set(rows.map((r) => r.session)).size > 1;
  for (const r of rows) {
    const row = el("div"), a = el("span", "a", r.action);
    if (multi) a.append(el("span", "s", ` · ${r.session}`));
    row.append(a);
    if (r.status !== "ok") row.append(el("span", "x", r.status));
    row.append(el("span", "t", r.time));
    recent.append(row);
  }
  if (!(st.recent || []).length) recent.append(el("div", "empty", "Nothing yet."));

  const kill = $("kill");
  kill.textContent = st.enabled ? "Pause Cohand here" : "Resume";
  kill.className = "kill" + (st.enabled ? "" : " resume");
  kill.onclick = async () => { await chrome.storage.local.set({ enabled: !st.enabled }); setTimeout(refresh, 400); };
}

// Save while typing: the popup can close before "change" ever fires.
let nameTimer;
const saveName = () => {
  clearTimeout(nameTimer);
  const v = $("profile").value.trim();
  if (v) chrome.storage.local.set({ profileLabel: v });
};
$("profile").addEventListener("input", () => { clearTimeout(nameTimer); nameTimer = setTimeout(saveName, 400); });
$("profile").addEventListener("change", saveName);
$("profile").addEventListener("keydown", (e) => { if (e.key === "Enter") $("profile").blur(); });

$("anyTab").addEventListener("change", async () => {
  const r = await bg({ popup: "call", op: "policy.anyTab", args: { on: $("anyTab").checked } });
  if (!r.ok) $("err").textContent = r.error;
  refresh();
});

$("block").addEventListener("change", async () => {
  const r = await bg({ popup: "call", op: "policy.block", args: { domain, on: $("block").checked } });
  if (!r.ok) $("err").textContent = r.error;
  refresh();
});

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
domain = tab?.url ? domainOf(tab.url) : null;
refresh();
setInterval(refresh, 3000);
