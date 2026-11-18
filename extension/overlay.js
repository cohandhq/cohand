// cohand — on-page overlay. One job: draw the "agent is here" glow border, ghost cursor,
// click ripple and element highlight. Lives in a closed Shadow DOM on <html> (not <body>),
// so snapshot/find/text never see it and page layout never moves. Inject after snapshot-core.js.

(function () {
  "use strict";
  if (self.__cohandOverlay) return;

  var GLOW_MS = 2500;
  var MOVE_MS = 280;
  var host = null, root = null, glow = null, cursor = null, box = null;
  var glowTimer = null, boxTimer = null;
  var cx = null, cy = null;

  var CSS =
    ".glow{position:fixed;inset:0;opacity:0;transition:opacity .6s ease;border-radius:6px;" +
    "box-shadow:inset 0 0 0 2px rgba(34,211,166,.7),inset 0 0 36px 6px rgba(34,211,166,.45),inset 0 0 90px 10px rgba(66,250,199,.22);" +
    "animation:pulse 2.4s ease-in-out infinite}" +
    ".glow.on{opacity:1}" +
    "@keyframes pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.5)}}" +
    ".cur{position:fixed;left:0;top:0;width:22px;height:22px;opacity:0;will-change:transform;" +
    "transition:transform " + MOVE_MS + "ms cubic-bezier(.22,.61,.36,1),opacity .4s ease;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}" +
    ".cur.on{opacity:1}" +
    ".cur.jump{transition:opacity .4s ease}" +
    ".box{position:fixed;opacity:0;border:2px solid rgb(34,211,166);border-radius:4px;background:rgba(34,211,166,.12);" +
    "box-shadow:0 0 0 3px rgba(34,211,166,.25);transition:opacity .25s ease}" +
    ".box.on{opacity:1}" +
    ".rip{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;" +
    "border:2px solid rgb(34,211,166);animation:rip .6s ease-out forwards}" +
    "@keyframes rip{from{transform:scale(.4);opacity:.9}to{transform:scale(4.5);opacity:0}}";

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement("cohand-overlay");
    host.setAttribute("data-cohand-overlay", "1");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    root = host.attachShadow({ mode: "closed" });
    var style = el("style");
    style.textContent = CSS;
    glow = el("div", "glow");
    box = el("div", "box");
    cursor = el("div", "cur");
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 7.5-6 1.8-2.2 6z" fill="#6366f1" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    root.appendChild(style);
    root.appendChild(glow);
    root.appendChild(box);
    root.appendChild(cursor);
    document.documentElement.appendChild(host);
  }

  function showGlow(ms) {
    ensure();
    glow.classList.add("on");
    clearTimeout(glowTimer);
    glowTimer = setTimeout(function () {
      glow.classList.remove("on");
      cursor.classList.remove("on");
    }, ms == null ? GLOW_MS : ms);
  }

  function moveCursor(x, y) {
    if (cx === null || !cursor.classList.contains("on")) {
      // first appearance: start from a nearby point so it visibly travels
      cursor.classList.add("jump");
      cursor.style.transform = "translate(" + Math.max(0, x - 90) + "px," + Math.max(0, y - 60) + "px)";
      void cursor.offsetWidth;
      cursor.classList.remove("jump");
    }
    cursor.classList.add("on");
    cursor.style.transform = "translate(" + x + "px," + y + "px)";
    cx = x; cy = y;
  }

  function ripple(x, y) {
    var r = el("div", "rip");
    r.style.left = x + "px";
    r.style.top = y + "px";
    root.appendChild(r);
    setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 700);
  }

  function highlight(rect) {
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    box.classList.add("on");
    clearTimeout(boxTimer);
    boxTimer = setTimeout(function () { box.classList.remove("on"); }, 1200);
  }

  /**
   * opts: { mode: "click"|"move"|"box"|"point"|"glow", x, y, rect:{left,top,width,height}, glowMs }
   * click/move: cursor glides to (x,y); click also ripples. box: cursor to rect centre + highlight.
   * point: cursor at (x,y) (scroll). glow: border only.
   */
  function show(opts) {
    showGlow(opts.glowMs);
    var m = opts.mode;
    if (m === "box" && opts.rect) {
      moveCursor(Math.round(opts.rect.left + opts.rect.width / 2), Math.round(opts.rect.top + opts.rect.height / 2));
      highlight(opts.rect);
    } else if ((m === "click" || m === "move" || m === "point") && typeof opts.x === "number") {
      moveCursor(opts.x, opts.y);
      if (m === "click") setTimeout(function () { ripple(opts.x, opts.y); }, MOVE_MS);
    }
  }

  /** Hide (for screenshots) or restore without losing state. */
  function suspend(on) {
    if (host) host.style.visibility = on ? "hidden" : "visible";
  }

  /** Remove everything (session ended). */
  function off() {
    clearTimeout(glowTimer);
    clearTimeout(boxTimer);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; cx = cy = null;
  }

  self.__cohandOverlay = { show: show, suspend: suspend, off: off, GLOW_MS: GLOW_MS, MOVE_MS: MOVE_MS };
})();
