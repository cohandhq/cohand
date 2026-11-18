// cohand — content script glue. One job: bridge chrome.runtime messages to the
// snapshot core. Must be injected AFTER snapshot-core.js.

(function () {
  "use strict";
  if (self.__cohandContentInstalled) return;
  self.__cohandContentInstalled = true;

  var C = self.__cohandCore;
  if (!C) return; // snapshot-core.js missing — executor injects both files

  function refs() { return self.__cohandRefs; }

  /** Focus a coordinate or the already-focused element. Used when snapshot-core has no focusAt yet. */
  function focusAtLocal(msg) {
    var el = msg.focused ? document.activeElement : document.elementFromPoint(msg.x, msg.y);
    var tag = String(el && el.tagName || "").toUpperCase();
    if (!el || tag === "BODY" || tag === "HTML") throw new Error("no element");
    var typeAttr = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
    if (tag === "INPUT" && typeAttr === "password") throw new Error("typing into password fields is blocked");
    if (typeof el.focus === "function") el.focus();
    return {};
  }

  function inspect(msg) {
    var el = null;
    if (msg.ref) el = refs() && refs().get(msg.ref);
    else if (typeof msg.x === "number") el = document.elementFromPoint(msg.x, msg.y);
    else if (msg.op === "key") el = document.activeElement;
    var risky = false;
    if (el) {
      risky = C.isRisky(el);
      if (!risky && msg.op === "type" && msg.submit) risky = !!(el.closest && el.closest("form"));
      if (!risky && msg.op === "key" && el.closest && el.closest("form")) risky = true;
    }
    var ownerWindow = el && el.ownerDocument && el.ownerDocument.defaultView;
    var readsFrames = ["snapshot", "text", "find", "wait"].includes(msg.op);
    return { url: ownerWindow?.location?.href || location.href, risky: risky,
      frameUrls: readsFrames ? C.accessibleFrameUrls(document) : [] };
  }

  /** Draw the overlay for an action. Resolves a ref to its box (scrolling it into view first). */
  function overlay(msg) {
    var O = self.__cohandOverlay;
    if (!O) return {};
    if (msg.mode === "suspend") { O.suspend(msg.on); return {}; }
    if (msg.mode === "off") { O.off(); return {}; }
    var o = { mode: msg.mode, x: msg.x, y: msg.y, glowMs: msg.glowMs };
    try {
      var el = msg.ref && refs() && refs().get(msg.ref);
      if (el && el.isConnected) {
        try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) { /* ok */ }
        var r = el.getBoundingClientRect();
        o.rect = { left: r.left, top: r.top, width: r.width, height: r.height };
        o.x = Math.round(r.left + r.width / 2);
        o.y = Math.round(r.top + r.height / 2);
      } else if (msg.mode === "point" && typeof o.x !== "number") {
        o.x = Math.round(self.innerWidth / 2);
        o.y = Math.round(self.innerHeight / 2);
      }
      O.show(o);
    } catch (e) { /* the overlay must never break an action */ }
    return {};
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.__cohand !== true) return;
    try {
      switch (msg.cmd) {
        case "snapshot": {
          var r = C.buildSnapshot(document, self, { scope: msg.scope, page: msg.page });
          sendResponse({ ok: true, data: { text: r.text || "(no readable content in the accessible document; cross-origin frames are not inspected)", url: location.href, title: document.title } });
          return;
        }
        case "find": {
          var snap = C.buildSnapshot(document, self, { all: true });
          var lines = C.findLines(snap.text, msg.query);
          sendResponse({ ok: true, data: { text: lines.join("\n") || "(no match)", url: location.href } });
          return;
        }
        case "click": sendResponse({ ok: true, data: C.applyClick(self, refs(), msg.ref) }); return;
        case "type": sendResponse({ ok: true, data: C.applyType(self, refs(), msg.ref, msg.text, { submit: false }) }); return;
        case "focus_select": sendResponse({ ok: true, data: C.focusSelect(self, refs(), msg.ref) }); return;
        case "focus_at":
          sendResponse({ ok: true, data: (typeof C.focusAt === "function" ? C.focusAt(self, { x: msg.x, y: msg.y, focused: !!msg.focused }) : focusAtLocal(msg)) || {} });
          return;
        case "read_value": {
          var el = refs() && refs().get(msg.ref);
          if (!el || !el.isConnected) throw new Error("stale snapshot: ref " + msg.ref + " not found on this page — run `cohand snapshot` again");
          sendResponse({ ok: true, data: { value: C.readValue(el) } });
          return;
        }
        case "submit": sendResponse({ ok: true, data: C.submitEl(self, refs(), msg.ref) }); return;
        case "rect": sendResponse({ ok: true, data: C.rectOf(self, refs(), msg.ref) }); return;
        case "mark": sendResponse({ ok: true, data: C.markEl(self, refs(), msg.ref) }); return;
        case "overlay": sendResponse({ ok: true, data: overlay(msg) }); return;
        case "inspect": sendResponse({ ok: true, data: inspect(msg) }); return;
        case "scroll":
          sendResponse({ ok: true, data: C.scrollBy(self, msg.direction || "down", msg.amount || 600) });
          return;
        case "select": C.applySelect(self, refs(), msg.ref, msg.value); sendResponse({ ok: true, data: {} }); return;
        case "get_text":
          var visibleText = C.getText(document, msg.selector);
          if (!visibleText && !msg.selector) visibleText = "(no readable content in the accessible document; cross-origin frames are not inspected)";
          sendResponse({ ok: true, data: { text: visibleText, url: location.href } });
          return;
        case "wait_for":
          C.waitFor(self, { text: msg.text, selector: msg.selector, idle: msg.idle, timeoutMs: msg.timeoutMs })
            .then(function (r) { sendResponse({ ok: true, data: r }); })
            .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
          return true; // async response
        default:
          sendResponse({ ok: false, error: "unknown content command: " + msg.cmd });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  });
})();
