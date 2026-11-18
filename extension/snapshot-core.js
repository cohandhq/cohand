// cohand — snapshot core. Pure DOM logic shared by the content script and tests.
// One job: turn the live page into a readable tree with element refs, and act on refs.

(function (root) {
  "use strict";

  var MAX_NODES = 2000;
  var MAX_DEPTH = 60;      // meaningful levels only (wrapper divs don't count)
  var MAX_RAW_DEPTH = 400; // hard stop on raw DOM nesting
  var MAX_VISIT = 100000;  // elements looked at, so a huge page can't hang us
  var NAME_MAX = 120;
  var LINE_MAX = 200;

  var INTERACTIVE_ROLES = {
    link: true, button: true, textbox: true, combobox: true, checkbox: true,
    radio: true, slider: true, option: true, switch: true, "menu-item": true, tab: true,
  };
  var STRUCTURAL_ROLES = { heading: true, image: true, list: true, listitem: true, separator: true, label: true };

  function isPassword(el) {
    return !!el && el.tagName === "INPUT" && String(el.getAttribute("type") || "").toLowerCase() === "password";
  }

  var RISKY_RE = /\b(pay|buy|purchase|delete|remove|send|publish|deploy|confirm|submit)\b/i;
  var CHIP_RE = /\b(remove|close|dismiss|clear|delete)\b/i;

  /** Would clicking this element plausibly be irreversible? Text match or a form submit. */
  function isRisky(el) {
    if (!el) return false;
    var t = el.closest ? (el.closest("button,a,input,[role=button],[role=menuitem]") || el) : el;
    var type = String((t.getAttribute && t.getAttribute("type")) || "").toLowerCase();
    var inForm = !!(t.closest && t.closest("form"));
    if (type === "submit" && (inForm || t.tagName === "INPUT" || t.tagName === "BUTTON")) return true;
    if (t.tagName === "BUTTON" && !type && inForm) return true;
    var text = norm((t.getAttribute && t.getAttribute("aria-label")) || t.value || t.textContent || "");
    return RISKY_RE.test(text);
  }

  function norm(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") {
      try { if (!el.checkVisibility({ checkVisibilityCSS: true })) return false; } catch (e) { /* fall through */ }
    }
    if (el.hidden === true) return false;
    if (el.inert === true) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    if (el.style && (el.style.display === "none" || el.style.visibility === "hidden" || el.style.opacity === "0")) return false;
    try {
      if (el.closest('[aria-hidden="true"], [inert]')) return false;
      var w = el.ownerDocument && el.ownerDocument.defaultView;
      var cs = w && w.getComputedStyle && w.getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0")) return false;
    } catch (e) { /* best effort for unusual DOMs */ }
    return true;
  }

  /**
   * Skip this node and everything inside it.
   * display:contents is not a reason: it draws no box, but its children do.
   * A failed checkVisibility is not a reason either (zero-box wrappers).
   */
  function hidesSubtree(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden === true || el.inert === true) return true;
    if (el.hasAttribute && el.hasAttribute("hidden")) return true;
    if (el.hasAttribute && el.hasAttribute("inert")) return true;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    if (el.style && (el.style.display === "none" || el.style.visibility === "hidden")) return true;
    try {
      var parent = el.parentElement;
      if (parent && parent.closest && parent.closest('[aria-hidden="true"], [inert]')) return true;
      var w = el.ownerDocument && el.ownerDocument.defaultView;
      var cs = w && w.getComputedStyle && w.getComputedStyle(el);
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0")) return true;
    } catch (e) { /* best effort for unusual DOMs */ }
    return false;
  }

  function isEditingHost(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (!el.getAttribute) return false;
    var ce = el.getAttribute("contenteditable");
    if (ce == null) return false;
    return String(ce).toLowerCase() !== "false";
  }

  /** aria-label dismiss controls (Ahrefs chips) are buttons. Never override a textbox. */
  function chipButton(el) {
    if (!el || isEditingHost(el)) return null;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return null;
    var aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && CHIP_RE.test(aria)) return "button";
    return null;
  }

  /** Enumerate accessible frame URLs before a read so daemon policy covers nested documents. */
  function accessibleFrameUrls(doc) {
    var urls = [];
    var stack = doc.body ? [{ el: doc.body, depth: 0 }] : [];
    var visited = 0;
    while (stack.length) {
      var item = stack.pop(), el = item.el;
      if (++visited > MAX_VISIT || item.depth > MAX_RAW_DEPTH) throw new Error("frame policy inspection limit hit — narrow the page before reading");
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        if (!isVisible(el)) continue;
        var childDoc = null;
        try { childDoc = el.contentDocument; } catch (e) { /* inaccessible frame */ }
        if (childDoc) {
          urls.push(childDoc.URL);
          if (childDoc.body) stack.push({ el: childDoc.body, depth: item.depth + 1 });
        }
      }
      var kids = el.children || [];
      for (var i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i], depth: item.depth + 1 });
      if (el.shadowRoot) {
        var shadowKids = el.shadowRoot.children || [];
        for (var j = shadowKids.length - 1; j >= 0; j--) stack.push({ el: shadowKids[j], depth: item.depth + 1 });
      }
    }
    return urls;
  }

  function labelFor(doc, el) {
    var id = el.id;
    if (id) {
      var lab = doc.querySelector('label[for="' + CSSescape(id) + '"]');
      if (lab) return norm(lab.textContent);
    }
    try { var wrap = el.closest("label"); if (wrap) return norm(wrap.textContent); } catch (e) { /* ok */ }
    return "";
  }

  function roleFor(el) {
    var role = el.getAttribute && el.getAttribute("role");
    if (role && (INTERACTIVE_ROLES[role] || STRUCTURAL_ROLES[role])) return role;
    var tag = el.tagName;
    switch (tag) {
      case "A": return el.hasAttribute("href") ? "link" : chipButton(el);
      case "AREA": return "link";
      case "BUTTON": return "button";
      case "SUMMARY": return "button";
      case "TEXTAREA": return "textbox";
      case "SELECT": return "combobox";
      case "OPTION": return "option";
      case "IMG": return "image";
      case "INPUT": {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "hidden") return null;
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
        return "textbox";
      }
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "UL": case "OL": return "list";
      case "LI": return "listitem";
      case "HR": return "separator";
      case "LABEL": return "label";
      default:
        if (isEditingHost(el)) return "textbox";
        if (el.hasAttribute && el.hasAttribute("onclick")) return "button";
        return chipButton(el);
    }
  }

  function nameFor(doc, el, role) {
    var n =
      norm(el.getAttribute && el.getAttribute("aria-label")) ||
      labelFor(doc, el) ||
      norm(el.getAttribute && el.getAttribute("alt")) ||
      norm(el.getAttribute && el.getAttribute("title")) ||
      norm(el.getAttribute && el.getAttribute("placeholder"));
    if (!n && role === "combobox" && el.selectedOptions && el.selectedOptions[0]) n = norm(el.selectedOptions[0].textContent);
    if (!n && role === "textbox" && el.value && !isPassword(el)) n = norm(el.value);
    if (!n && !isPassword(el)) n = norm(el.textContent);
    if (!n && role === "link") n = norm(el.getAttribute("href")).slice(0, 80);
    return n.slice(0, NAME_MAX);
  }

  function extraFor(el, role) {
    var out = [];
    if (role === "textbox" && el.value && !isPassword(el)) out.push('="' + norm(el.value).slice(0, 60) + '"');
    if ((role === "checkbox" || role === "radio") && el.checked) out.push("[checked]");
    if (role === "combobox" && el.selectedOptions && el.selectedOptions[0]) out.push('="' + norm(el.selectedOptions[0].textContent).slice(0, 60) + '"');
    if (el.hasAttribute && el.hasAttribute("disabled")) out.push("[disabled]");
    return out.join(" ");
  }

  /**
   * opts.scope: "eN" (ref from the last snapshot) or a CSS selector — snapshot only that subtree.
   * opts.page: N>=1 — full document-order listing, MAX_NODES lines per page.
   * opts.all: no line cap (used by find to search the whole DOM).
   * Without page, an oversized page keeps every interactive line and fills the rest with text.
   */
  function buildSnapshot(doc, win, opts) {
    opts = opts || {};
    var lines = [];
    var kinds = []; // parallel to lines: true = interactive/structural, false = plain text
    var refMap = new Map();
    var refCounter = 0;
    var visited = 0;
    var truncated = false;
    var limitHit = false;
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 };

    function walk(el, depth, raw, ownerDoc) {
      if (truncated || !el) return;
      if (++visited > MAX_VISIT) { truncated = true; return; }
      // A deeply nested branch must not prevent traversal of its later siblings.
      if (raw > MAX_RAW_DEPTH || depth > MAX_DEPTH) { limitHit = true; return; }
      ownerDoc = ownerDoc || el.ownerDocument || doc;
      var tag = el.tagName;
      if (SKIP[tag]) return;
      if (tag === "OPTION" && el.parentElement && el.parentElement.tagName === "SELECT") return;
      // Hidden, inert, aria-hidden, display:none: leave the whole subtree out.
      // display:contents and a zero box still descend so the visible children are kept.
      if (hidesSubtree(el)) return;

      var role = roleFor(el);
      var interactive = !!(role && INTERACTIVE_ROLES[role]);
      var show = isVisible(el) || interactive;
      var own = show ? ownText(el) : "";
      var name = show && role ? nameFor(ownerDoc, el, role) : "";
      var line = null;
      var crossOrigin = false;

      if (show && role && (INTERACTIVE_ROLES[role] || STRUCTURAL_ROLES[role])) {
        var skipLine = !interactive && (
          (role === "image" && !name && !(el.getAttribute && el.getAttribute("src"))) ||
          (role === "listitem" && !name && !(el.querySelector && el.querySelector("a,button,input")))
        );
        if (!skipLine) {
          var label = role + (name ? ' "' + name + '"' : "");
          var extra = extraFor(el, role);
          if (interactive) {
            refCounter++;
            var ref = "e" + refCounter;
            refMap.set(ref, el);
            line = "- " + label + (extra ? " " + extra : "") + " [" + ref + "]";
          } else {
            line = "- " + label + (extra ? " " + extra : "");
          }
        }
      } else if (show && own) {
        line = '- "' + own.slice(0, LINE_MAX) + '"';
      }

      var frameDoc = null;
      if (tag === "IFRAME" || tag === "FRAME") {
        try { frameDoc = el.contentDocument || null; } catch (e) { frameDoc = null; }
        if (!frameDoc) {
          crossOrigin = true;
          var src = norm((el.getAttribute && el.getAttribute("src")) || "");
          line = '- iframe "' + src.slice(0, NAME_MAX) + '" (cross-origin, not readable)';
        }
      }

      if (line) { lines.push("  ".repeat(depth) + line); kinds.push(!crossOrigin && !!role); }

      // wrappers (no role, no own text) add no level, so deep apps aren't cut off
      var next = line ? depth + 1 : depth;
      var kids = el.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i], next, raw + 1, ownerDoc);
      var shadow = el.shadowRoot;
      if (shadow && shadow.children) {
        for (var j = 0; j < shadow.children.length; j++) walk(shadow.children[j], next, raw + 1, shadow.ownerDocument || ownerDoc);
      }
      if (frameDoc && frameDoc.body) walk(frameDoc.body, next, 0, frameDoc);
    }

    function ownText(el) {
      var out = "";
      var kids = el.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var n = kids[i];
        if (n.nodeType === 3) out += n.textContent + " ";
      }
      return norm(out);
    }

    var root = doc.body;
    if (opts.scope) {
      var sc = String(opts.scope);
      var prev = win && win.__cohandRefs;
      root = /^e\d+$/.test(sc) && prev ? prev.get(sc) : doc.querySelector(sc);
      if (!root || (root.isConnected === false)) throw new Error('scope "' + sc + '" not found — use a ref from the last snapshot or a CSS selector');
    }
    if (root) walk(root, 0, 0, root.ownerDocument || doc);

    var total = lines.length;
    var note = "";
    if (!opts.all && total > MAX_NODES) {
      if (opts.page) {
        var pages = Math.ceil(total / MAX_NODES);
        var pg = Math.max(1, Math.floor(opts.page));
        if (pg > pages) throw new Error("page " + pg + " out of range (1-" + pages + ")");
        lines = lines.slice((pg - 1) * MAX_NODES, pg * MAX_NODES);
        note = "…[page " + pg + "/" + pages + (pg < pages ? " — next: --page " + (pg + 1) : "") + "; refs are valid on every page]";
      } else {
        var budget = MAX_NODES;
        var keep = kinds.map(function () { return false; });
        kinds.forEach(function (k, i) { if (k && budget > 0) { keep[i] = true; budget--; } });
        kinds.forEach(function (k, i) { if (!k && budget > 0) { keep[i] = true; budget--; } });
        var kept = lines.filter(function (l, i) { return keep[i]; });
        lines = kept;
        note = "…[page too large: " + total + " lines, showing " + kept.length + ": controls first, some text dropped — full listing: --page 1..." + Math.ceil(total / MAX_NODES) + "; narrow with --scope <ref|selector>; or `cohand find \"text\"`]";
      }
    }
    var text = lines.join("\n");
    if (note) text += "\n" + note;
    if (truncated || limitHit) text += "\n…[stopped early — DOM nesting/size limit hit; use --scope]";
    if (win) win.__cohandRefs = refMap;
    return { text: text, refMap: refMap };
  }

  function getRef(win, refMap, ref) {
    var el = refMap && refMap.get(ref);
    if (!el || !el.isConnected) {
      throw new Error("stale snapshot: ref " + ref + " not found on this page — run `cohand snapshot` again");
    }
    return el;
  }

  function fire(el, type, opts) {
    var w = el.ownerDocument.defaultView;
    el.dispatchEvent(new w.Event(type, Object.assign({ bubbles: true, cancelable: true }, opts || {})));
  }

  function applyClick(win, refMap, ref) {
    var el = getRef(win, refMap, ref);
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) { /* ok */ }
    el.click();
    return { after: norm(win.document.title).slice(0, 200) };
  }

  function nativeSetter(el) {
    var proto = el.tagName === "TEXTAREA" ? win2(el).HTMLTextAreaElement.prototype : win2(el).HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value").set;
  }
  function win2(el) { return el.ownerDocument.defaultView; }

  function readValue(el) {
    return el.isContentEditable ? el.textContent : el.value;
  }

  /**
   * Focus the element under a point, or the already focused element.
   * opts.focused: use document.activeElement. Otherwise elementFromPoint(opts.x, opts.y).
   */
  function focusAt(win, opts) {
    opts = opts || {};
    var doc = win.document;
    var el = opts.focused ? doc.activeElement : (doc.elementFromPoint ? doc.elementFromPoint(opts.x, opts.y) : null);
    if (!el || el === doc.body || el === doc.documentElement) {
      throw new Error("no element there — click a field or pass a snapshot ref");
    }
    if (isPassword(el)) throw new Error("typing into password fields is blocked");
    el.focus();
    return { tag: String(el.tagName || "").toLowerCase() };
  }

  /** Focus an input and select its content so a real insertText replaces it. */
  function focusSelect(win, refMap, ref) {
    var el = getRef(win, refMap, ref);
    if (isPassword(el)) throw new Error("typing into password fields is blocked");
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) { /* ok */ }
    el.focus();
    if (el.isContentEditable) {
      var r = el.ownerDocument.createRange();
      r.selectNodeContents(el);
      var ownerWin = el.ownerDocument.defaultView || win;
      var sel = ownerWin.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (typeof el.select === "function") {
      el.select();
    }
    return {};
  }

  function submitEl(win, refMap, ref) {
    var el = getRef(win, refMap, ref);
    var form = el.closest ? el.closest("form") : null;
    if (form) {
      try { form.requestSubmit(); return {}; } catch (e) { /* fall through to Enter */ }
    }
    var ownerWin = el.ownerDocument.defaultView || win;
    dispatchPress(ownerWin, "Enter");
    return {};
  }

  /** Viewport centre of a ref (after scrolling into view) for real mouse input. */
  function rectOf(win, refMap, ref) {
    var el = getRef(win, refMap, ref);
    try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (e) { /* ok */ }
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var ownerWin = el.ownerDocument.defaultView;
    while (ownerWin && ownerWin !== win && ownerWin.frameElement) {
      var frame = ownerWin.frameElement;
      var fr = frame.getBoundingClientRect();
      x += fr.left; y += fr.top;
      ownerWin = frame.ownerDocument.defaultView;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function markEl(win, refMap, ref) {
    var old = win.document.querySelectorAll("[data-cohand-mark]");
    for (var i = 0; i < old.length; i++) old[i].removeAttribute("data-cohand-mark");
    getRef(win, refMap, ref).setAttribute("data-cohand-mark", "1");
    return {};
  }

  /** Lines of a snapshot matching every word in the query (case-insensitive). */
  function findLines(text, query) {
    var words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return String(text).split("\n").filter(function (l) {
      var low = l.toLowerCase();
      return words.every(function (w) { return low.indexOf(w) !== -1; });
    });
  }

  function applyType(win, refMap, ref, text, opts) {
    var el = getRef(win, refMap, ref);
    opts = opts || {};
    if (isPassword(el)) throw new Error("typing into password fields is blocked");
    el.focus();
    if (el.isContentEditable) {
      el.textContent = text;
      fire(el, "input");
    } else {
      var setter = nativeSetter(el);
      setter.call(el, text);
      fire(el, "input");
      fire(el, "change");
    }
    var stuck = readValue(el) === text;
    if (opts.submit && stuck) {
      var form = el.closest ? el.closest("form") : null;
      if (form) {
        try { form.requestSubmit(); return; } catch (e) { /* fall through to Enter */ }
      }
      dispatchPress(el.ownerDocument.defaultView || win, "Enter");
    }
    return { stuck: stuck, value: readValue(el) };
  }

  function optionValue(el) {
    var attr = el.getAttribute ? (el.getAttribute("value") || el.getAttribute("data-value") || el.getAttribute("aria-label")) : "";
    return norm(attr || el.value || "");
  }

  function optionMatches(el, want) {
    var value = optionValue(el);
    var text = norm(el.textContent);
    return value === want || value.toLowerCase() === want.toLowerCase() || text === want || text.toLowerCase() === want.toLowerCase();
  }

  function customOptions(el) {
    var doc = el.ownerDocument;
    var roots = [];
    var MAX_OPTIONS = 200;
    var ids = String(el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean);
    for (var i = 0; i < ids.length; i++) {
      var root = doc.getElementById(ids[i]);
      if (root) roots.push(root);
    }
    if (!roots.length) {
      var parent = el.closest && el.closest('[role="listbox"]');
      roots.push(parent || el);
    }
    var out = [];
    var add = function (root) {
      if (out.length >= MAX_OPTIONS) return;
      if (root.getAttribute && root.getAttribute("role") === "option" && isVisible(root)) out.push(root);
      var found = root.querySelectorAll ? root.querySelectorAll('[role="option"]') : [];
      for (var j = 0; j < found.length && out.length < MAX_OPTIONS; j++) if (isVisible(found[j])) out.push(found[j]);
    };
    for (var k = 0; k < roots.length; k++) add(roots[k]);
    return out;
  }

  function applySelect(win, refMap, ref, value) {
    var el = getRef(win, refMap, ref);
    var want = String(value);
    if (el.tagName === "SELECT") {
      var nativeOpts = el.options || [];
      for (var i = 0; i < nativeOpts.length; i++) {
        var native = nativeOpts[i];
        if (native.value === want || norm(native.textContent) === want || norm(native.textContent).toLowerCase() === want.toLowerCase()) {
          el.value = native.value;
          fire(el, "input");
          fire(el, "change");
          return { value: native.value, text: norm(native.textContent) };
        }
      }
      throw new Error('no option "' + want + '" in ' + ref);
    }
    if (isRisky(el)) throw new Error("risky dropdown trigger — use click so approval is checked");
    if (el.getAttribute("aria-expanded") !== "true") el.click();
    var opts = customOptions(el);
    var hit = null;
    for (var j = 0; j < opts.length; j++) if (optionMatches(opts[j], want)) { hit = opts[j]; break; }
    if (!hit) {
      if (!opts.length) throw new Error('no visible option "' + want + '" for ' + ref + ' — open the combobox or refresh the snapshot');
      throw new Error('no option "' + want + '" in ' + ref + ' (visible options: ' + opts.map(function (o) { return norm(o.textContent); }).join(", ") + ')');
    }
    if (isRisky(hit)) throw new Error("risky dropdown option — use click so approval is checked");
    hit.click();
    return { value: optionValue(hit), text: norm(hit.textContent) };
  }

  function dispatchPress(win, key) {
    var doc = win.document;
    var target = doc.activeElement || doc.body;
    ["keydown", "keyup"].forEach(function (type) {
      target.dispatchEvent(new win.KeyboardEvent(type, { key: key, bubbles: true, cancelable: true }));
    });
  }

  function scrollBy(win, direction, amount) {
    var dy = direction === "up" ? -amount : amount;
    var x = Math.floor(win.innerWidth / 2), y = Math.floor(win.innerHeight / 2);
    var el = win.document.elementFromPoint ? win.document.elementFromPoint(x, y) : null;
    while (el && el !== win.document.documentElement) {
      var style = win.getComputedStyle ? win.getComputedStyle(el) : null;
      var overflow = style && (style.overflowY || style.overflow);
      if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") && el.scrollHeight > el.clientHeight) {
        el.scrollTop += dy;
        return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, target: "container" };
      }
      el = el.parentElement;
    }
    win.scrollBy(0, dy);
    return { scrollY: win.scrollY, scrollHeight: win.document.documentElement.scrollHeight, target: "window" };
  }

  function getText(doc, selector) {
    var el = doc.body;
    if (selector) {
      el = doc.querySelector(selector);
      if (!el) throw new Error("no match for selector \"" + selector + "\"");
    }
    var visitedText = 0;
    var truncatedText = false;
    function textFor(node) {
      if (!node) return "";
      if (++visitedText > MAX_VISIT) { truncatedText = true; return ""; }
      if (node.nodeType === 3) return norm(node.textContent);
      if (node.nodeType !== 1 || hidesSubtree(node)) return "";
      var tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return "";
      var parts = [];
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var part = textFor(kids[i]);
        if (part) parts.push(part);
      }
      var shadow = node.shadowRoot;
      if (shadow && shadow.children) {
        for (var j = 0; j < shadow.children.length; j++) {
          var shadowPart = textFor(shadow.children[j]);
          if (shadowPart) parts.push(shadowPart);
        }
      }
      if (tag === "IFRAME" || tag === "FRAME") {
        var childDoc = null;
        try { childDoc = node.contentDocument; } catch (e) { /* cross-origin frame */ }
        var framePart = childDoc && childDoc.body ? textFor(childDoc.body) : "";
        if (framePart) parts.push(framePart);
      }
      return norm(parts.join(" "));
    }
    var text = textFor(el).replace(/\n{3,}/g, "\n\n").trim();
    if (truncatedText) text += (text ? "\n" : "") + "…[text traversal limit hit; narrow with --selector]";
    return text;
  }

  function waitFor(win, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 10000;
    var started = Date.now();
    if (opts.idle) {
      return new Promise(function (resolve) {
        var timer;
        var obs = new win.MutationObserver(function () { clearTimeout(timer); timer = setTimeout(done, 500); });
        function done() { obs.disconnect(); resolve({ found: true, elapsedMs: Date.now() - started }); }
        obs.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true });
        timer = setTimeout(done, 500);
        setTimeout(done, timeoutMs);
      });
    }
    return new Promise(function (resolve, reject) {
      function check() {
        var doc = win.document;
        if (opts.selector && doc.querySelector(opts.selector)) {
          return resolve({ found: true, elapsedMs: Date.now() - started });
        }
        if (opts.text) {
          var t = doc.body ? (doc.body.innerText || doc.body.textContent || "") : "";
          if (t.indexOf(opts.text) !== -1) return resolve({ found: true, elapsedMs: Date.now() - started });
        }
        if (Date.now() - started >= timeoutMs) {
          return reject(new Error("timed out waiting for " + (opts.selector || ('"' + opts.text + '"')) + " after " + timeoutMs + "ms"));
        }
        setTimeout(check, 200);
      }
      check();
    });
  }

  function CSSescape(s) {
    return String(s).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, "\\$1");
  }

  var api = {
    buildSnapshot: buildSnapshot,
    applyClick: applyClick,
    applyType: applyType,
    applySelect: applySelect,
    dispatchPress: dispatchPress,
    scrollBy: scrollBy,
    getText: getText,
    waitFor: waitFor,
    roleFor: roleFor,
    nameFor: nameFor,
    isRisky: isRisky,
    accessibleFrameUrls: accessibleFrameUrls,
    isPassword: isPassword,
    focusSelect: focusSelect,
    focusAt: focusAt,
    submitEl: submitEl,
    rectOf: rectOf,
    markEl: markEl,
    findLines: findLines,
    readValue: readValue,
  };

  root.__cohandCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
