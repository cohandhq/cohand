import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../extension/snapshot-core.js");

const PAGE = `<!doctype html><html><body>
  <h1>Tiny Shop</h1>
  <nav><a href="/about">About us</a> <a href="https://example.com/cart">Cart (2)</a></nav>
  <main>
    <form>
      <label for="q">Search</label>
      <input id="q" placeholder="type here">
      <select id="size"><option value="s">Small</option><option value="l" selected>Large</option></select>
      <button type="submit" id="go">Search now</button>
    </form>
    <p>Welcome to the shop. We sell tiny things.</p>
    <div style="display:none"><button id="secret">Hidden button</button></div>
    <div aria-hidden="true"><a href="/skip">Skipped link</a></div>
  </main>
</body></html>`;

function dom() {
  return new JSDOM(PAGE, { url: "https://shop.test/" });
}

test("buildSnapshot assigns refs to interactive elements and renders roles", () => {
  const d = dom();
  const { text, refMap } = core.buildSnapshot(d.window.document);
  assert.match(text, /link "About us"/);
  assert.match(text, /link "Cart \(2\)"/);
  assert.match(text, /textbox "Search"/);
  assert.match(text, /combobox/);
  assert.match(text, /button "Search now"/);
  assert.match(text, /heading "Tiny Shop"/);
  assert.match(text, /\[e\d+\]/);
  const el = [...refMap.values()].find((e) => e.id === "go");
  assert.ok(el, "button got a ref");
  assert.equal(refMap.size >= 4, true);
});

test("hidden and aria-hidden elements are skipped", () => {
  const d = dom();
  const { text } = core.buildSnapshot(d.window.document);
  assert.doesNotMatch(text, /Hidden button/);
  assert.doesNotMatch(text, /Skipped link/);
});

test("click by ref clicks the element", async () => {
  const d = dom();
  let clicked = 0;
  d.window.document.getElementById("go").addEventListener("click", () => clicked++);
  const { refMap } = core.buildSnapshot(d.window.document);
  const ref = [...refMap.entries()].find(([, el]) => el.id === "go")[0];
  core.applyClick(d.window, refMap, ref);
  assert.equal(clicked, 1);
});

test("click with stale ref throws a clear error", () => {
  const d = dom();
  const { refMap } = core.buildSnapshot(d.window.document);
  assert.throws(() => core.applyClick(d.window, refMap, "e999"), /stale/i);
});

test("applyType sets value and fires input+change (native setter path)", async () => {
  const d = dom();
  const events = [];
  const q = d.window.document.getElementById("q");
  q.addEventListener("input", () => events.push("input"));
  q.addEventListener("change", () => events.push("change"));
  const { refMap } = core.buildSnapshot(d.window.document);
  const ref = [...refMap.entries()].find(([, el]) => el.id === "q")[0];
  core.applyType(d.window, refMap, ref, "tiny lamp", { submit: false });
  assert.equal(q.value, "tiny lamp");
  assert.deepEqual(events.sort(), ["change", "input"]);
});

test("applySelect picks option by visible text and fires change", () => {
  const d = dom();
  let changed = 0;
  const sel = d.window.document.getElementById("size");
  sel.addEventListener("change", () => changed++);
  const { refMap } = core.buildSnapshot(d.window.document);
  const ref = [...refMap.entries()].find(([, el]) => el.id === "size")[0];
  core.applySelect(d.window, refMap, ref, "Small");
  assert.equal(sel.value, "s");
  assert.equal(changed, 1);
});

test("custom combobox hides closed options, then selects by visible text or value", () => {
  const d = new JSDOM(`<!doctype html><body>
    <div id="combo" role="combobox" aria-controls="choices" aria-expanded="false">Ungrouped</div>
    <div id="choices" role="listbox" hidden>
      <div role="option" data-value="ungrouped">Ungrouped</div>
      <div role="option" data-value="tsio">The Story Isn't Over</div>
    </div>
  </body>`, { url: "https://business.google.com/locations" });
  const combo = d.window.document.getElementById("combo");
  const list = d.window.document.getElementById("choices");
  combo.addEventListener("click", () => { combo.setAttribute("aria-expanded", "true"); list.hidden = false; });
  list.querySelector('[data-value="tsio"]').addEventListener("click", (event) => event.currentTarget.setAttribute("aria-selected", "true"));
  const closed = core.buildSnapshot(d.window.document, d.window);
  assert.match(closed.text, /combobox "Ungrouped"/);
  assert.doesNotMatch(closed.text, /option "The Story Isn't Over"/);
  const ref = [...closed.refMap.entries()].find(([, el]) => el === combo)[0];
  core.applySelect(d.window, closed.refMap, ref, "tsio");
  assert.equal(combo.getAttribute("aria-expanded"), "true");
  assert.equal(list.querySelector('[data-value="tsio"]').getAttribute("aria-selected"), "true");
});

test("custom selection refuses risky options without clicking them", () => {
  const d = new JSDOM('<body><div id="combo" role="combobox" aria-expanded="true" aria-controls="choices">Actions</div><div id="choices" role="listbox"><div role="option">Delete account</div></div></body>', { url: "https://example.test/" });
  const { refMap } = core.buildSnapshot(d.window.document, d.window);
  const ref = [...refMap.entries()].find(([, el]) => el.id === "combo")[0];
  let clicks = 0;
  d.window.document.querySelector('[role="option"]').addEventListener("click", () => clicks++);
  assert.throws(() => core.applySelect(d.window, refMap, ref, "Delete account"), /risky.*click|click.*approval/i);
  assert.equal(clicks, 0);
});

test("custom selection does not click unrelated page options", () => {
  const d = new JSDOM('<body><div id="combo" role="combobox" aria-expanded="true" aria-controls="choices">Group</div><div id="choices" role="listbox"></div><div role="listbox"><div role="option">Elsewhere</div></div></body>', { url: "https://example.test/" });
  const { refMap } = core.buildSnapshot(d.window.document, d.window);
  const ref = [...refMap.entries()].find(([, el]) => el.id === "combo")[0];
  assert.throws(() => core.applySelect(d.window, refMap, ref, "Elsewhere"), /no visible option|no option/i);
});

test("native select exposes only the combobox and reports meaningful missing options", () => {
  const d = new JSDOM('<body><select id="group"><option value="u">Ungrouped</option><option value="t">The Story Isn\'t Over</option></select></body>', { url: "https://business.google.com/locations" });
  const { text, refMap } = core.buildSnapshot(d.window.document, d.window);
  assert.match(text, /combobox "Ungrouped"/);
  assert.doesNotMatch(text, /option/);
  const ref = [...refMap.entries()].find(([, el]) => el.id === "group")[0];
  assert.throws(() => core.applySelect(d.window, refMap, ref, "missing"), /no option "missing" in/);
});

test("snapshot and text include visible same-origin shadow and frame dialog content with unique refs", () => {
  const d = new JSDOM('<body><section id="host"></section><iframe id="frame"></iframe></body>', { url: "https://search.google.com/" });
  const host = d.window.document.getElementById("host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<dialog open><h2>Performance</h2><button>Interactions</button></dialog>';
  const frame = d.window.document.getElementById("frame");
  frame.contentDocument.body.innerHTML = '<div role="dialog" aria-modal="true"><h2>Calls</h2><button>Website clicks</button></div>';
  const result = core.buildSnapshot(d.window.document, d.window);
  assert.match(result.text, /Performance/);
  assert.match(result.text, /Website clicks/);
  assert.equal([...result.refMap.keys()].length, new Set(result.refMap.keys()).size);
  assert.match(core.getText(d.window.document), /Performance/);
  assert.match(core.getText(d.window.document), /Website clicks/);
});

test("read preflight reports visible accessible frame URLs, including shadow frames", () => {
  const d = new JSDOM('<body><iframe src="about:blank"></iframe><section id="host"></section></body>', { url: "https://example.test/" });
  const shadow = d.window.document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = '<iframe></iframe>';
  const shadowFrame = new JSDOM('<body>Frame</body>', { url: "https://example.test/inside" });
  Object.defineProperty(shadow.querySelector("iframe"), "contentDocument", { value: shadowFrame.window.document });
  assert.equal(core.accessibleFrameUrls(d.window.document).length, 2);
  d.window.document.querySelector("iframe").hidden = true;
  assert.equal(core.accessibleFrameUrls(d.window.document).length, 1);
});

test("getText returns visible body text, scoped by selector", () => {
  const d = dom();
  assert.match(core.getText(d.window.document), /tiny things/);
  assert.equal(core.getText(d.window.document, "#q"), "");
  assert.throws(() => core.getText(d.window.document, ".nope"), /no match/i);
});

test("waitFor resolves when text appears", async () => {
  const d = dom();
  const p = core.waitFor(d.window, { text: "late content", timeoutMs: 1500 });
  setTimeout(() => {
    const p2 = d.window.document.createElement("p");
    p2.textContent = "late content arrived";
    d.window.document.body.appendChild(p2);
  }, 150);
  const r = await p;
  assert.equal(r.found, true);
});

test("waitFor rejects on timeout when text never appears", async () => {
  const d = dom();
  await assert.rejects(core.waitFor(d.window, { text: "never", timeoutMs: 250 }), /timed out/i);
});

test("press dispatches keydown/keyup on the active element", () => {
  const d = dom();
  const keys = [];
  d.window.document.getElementById("q").focus();
  d.window.document.addEventListener("keydown", (e) => keys.push(`down:${e.key}`));
  d.window.document.addEventListener("keyup", (e) => keys.push(`up:${e.key}`));
  core.dispatchPress(d.window, "Enter");
  assert.deepEqual(keys, ["down:Enter", "up:Enter"]);
});

test("snapshot is size-capped", () => {
  const d = new JSDOM("<body>" + "<a href='#x'>x</a>".repeat(3000) + "</body>", { url: "https://big.test/" });
  const { text } = core.buildSnapshot(d.window.document);
  assert.ok(text.length < 60000, `snapshot too big: ${text.length}`);
  assert.match(text, /page too large/);
});

test("snapshot never includes password values; typing into password is blocked", () => {
  const d = new JSDOM('<body><label for="pw">Password</label><input id="pw" type="password" value="hunter2"><input id="u" value="bob"></body>', { url: "https://x.test/" });
  const { text, refMap } = core.buildSnapshot(d.window.document);
  assert.ok(!text.includes("hunter2"));
  assert.ok(text.includes("bob"));
  const ref = [...refMap.entries()].find(([, el]) => el.id === "pw")[0];
  assert.throws(() => core.applyType(d.window, refMap, ref, "x"), /typing into password fields is blocked/);
  assert.throws(() => core.focusSelect(d.window, refMap, ref), /password fields is blocked/);
});

test("isRisky: delete text and form submit true, plain menu button false", () => {
  const d = new JSDOM('<body><button id="a">Delete project</button><form><input type="submit" id="b" value="Go"></form><form><button id="c">Next</button></form><button id="d">Open menu</button><button id="e"><span id="s">Publish now</span></button></body>', { url: "https://x.test/" });
  const $ = (id) => d.window.document.getElementById(id);
  assert.equal(core.isRisky($("a")), true);
  assert.equal(core.isRisky($("b")), true);
  assert.equal(core.isRisky($("c")), true);
  assert.equal(core.isRisky($("d")), false);
  assert.equal(core.isRisky($("s")), true);
});

test("applyType reports when DOM typing did not stick (controlled input)", () => {
  const d = new JSDOM('<body><input id="q"></body>', { url: "https://x.test/" });
  const q = d.window.document.getElementById("q");
  q.addEventListener("input", () => { q.value = ""; }); // React-style revert
  const { refMap } = core.buildSnapshot(d.window.document);
  const r = core.applyType(d.window, refMap, "e1", "hello");
  assert.equal(r.stuck, false);
});

test("findLines matches all words", () => {
  const t = '- button "Save draft" [e1]\n- link "Save and publish" [e2]\n- link "Home" [e3]';
  assert.deepEqual(core.findLines(t, "save publish"), ['- link "Save and publish" [e2]']);
});

function deepDom(levels, extra = "") {
  const open = '<div class="w">'.repeat(levels);
  const close = "</div>".repeat(levels);
  return new JSDOM(`<!doctype html><body>${open}<div role="tab">Queries</div><button>Deep</button>${extra}${close}</body>`, { url: "https://app.test/" });
}

test("wrapper divs do not use up depth: controls 100 divs deep survive", () => {
  const d = deepDom(100);
  const { text } = core.buildSnapshot(d.window.document);
  assert.match(text, /tab "Queries"/);
  assert.match(text, /button "Deep"/);
  assert.doesNotMatch(text, /truncated|stopped early/);
  assert.match(text, /^- tab/m, "wrappers add no indentation");
});

test("oversized page keeps every control and says how to get the rest", () => {
  const texts = Array.from({ length: 2500 }, (_, i) => `<p>filler ${i}</p>`).join("");
  const d = deepDom(3, texts + '<a href="/z">Last link</a>');
  const { text, refMap } = core.buildSnapshot(d.window.document, d.window);
  assert.match(text, /link "Last link"/);
  assert.match(text, /tab "Queries"/);
  assert.match(text, /page too large/);
  assert.match(text, /--page/);
  assert.equal(refMap.size, 3);
});

test("--page lists everything in document order across pages", () => {
  const texts = Array.from({ length: 2500 }, (_, i) => `<p>filler ${i}</p>`).join("");
  const d = deepDom(3, texts);
  const p1 = core.buildSnapshot(d.window.document, d.window, { page: 1 }).text;
  const p2 = core.buildSnapshot(d.window.document, d.window, { page: 2 }).text;
  assert.match(p1, /filler 0"/);
  assert.match(p1, /page 1\/2/);
  assert.match(p2, /filler 2499"/);
  assert.throws(() => core.buildSnapshot(d.window.document, d.window, { page: 9 }), /out of range/);
});

test("scope by selector and by ref limits the snapshot", () => {
  const d = new JSDOM('<body><button>Outside</button><section id="s"><a href="/in">Inside</a></section></body>', { url: "https://app.test/" });
  const bySel = core.buildSnapshot(d.window.document, d.window, { scope: "#s" }).text;
  assert.match(bySel, /Inside/);
  assert.doesNotMatch(bySel, /Outside/);
  core.buildSnapshot(d.window.document, d.window);
  const ref = [...d.window.__cohandRefs.entries()].find(([, el]) => el.tagName === "A")[0];
  assert.doesNotMatch(core.buildSnapshot(d.window.document, d.window, { scope: ref }).text, /Outside/);
  assert.throws(() => core.buildSnapshot(d.window.document, d.window, { scope: "#nope" }), /not found/);
});

test("all:true (used by find) searches past the line cap", () => {
  const texts = Array.from({ length: 2500 }, (_, i) => `<p>filler ${i}</p>`).join("");
  const d = deepDom(3, texts + "<button>Group by</button>");
  const { text } = core.buildSnapshot(d.window.document, d.window, { all: true });
  assert.equal(core.findLines(text, "group by").length, 1);
});

test("display:contents wrapper keeps its visible subtree; display:none still hides", () => {
  const d = new JSDOM(`<!doctype html><body>
    <div id="wrap" style="display:contents">
      <main>
        <button id="go">Open report</button>
        <p>Active users today</p>
      </main>
    </div>
    <div style="display:none"><button id="secret">Hidden action</button></div>
  </body>`, { url: "https://analytics.google.com/" });
  // JSDOM has no checkVisibility. Real Chrome reports false for display:contents and for a zero-box wrapper.
  d.window.document.getElementById("wrap").checkVisibility = () => false;
  const snap = core.buildSnapshot(d.window.document, d.window);
  assert.match(snap.text, /button "Open report"/);
  assert.match(snap.text, /Active users today/);
  assert.doesNotMatch(snap.text, /Hidden action/);
  const text = core.getText(d.window.document);
  assert.match(text, /Open report/);
  assert.match(text, /Active users today/);
  assert.doesNotMatch(text, /Hidden action/);
});

test("aria-label remove chip is a button ref and textboxes stay textboxes", () => {
  const d = new JSDOM(`<!doctype html><body>
    <span id="chip" aria-label="Remove example.com">×</span>
    <input id="q" aria-label="Clear search">
    <div id="edit" contenteditable="true" aria-label="Remove note"></div>
  </body>`, { url: "https://app.ahrefs.com/" });
  d.window.document.getElementById("chip").checkVisibility = () => false;
  const { text, refMap } = core.buildSnapshot(d.window.document, d.window);
  assert.match(text, /button "Remove example.com" \[e\d+\]/);
  const chip = [...refMap.values()].find((el) => el.id === "chip");
  assert.ok(chip, "chip got a ref");
  assert.match(text, /textbox "Clear search"/);
  assert.match(text, /textbox "Remove note"/);
  assert.doesNotMatch(text, /button "Clear search"/);
  assert.doesNotMatch(text, /button "Remove note"/);
});

test("iframe whose contentDocument throws is cross-origin and not readable", () => {
  const d = new JSDOM(`<!doctype html><body>
    <iframe id="pay" src="https://payments.google.com/payments/u/0/documentcenter"></iframe>
    <iframe id="blank" src="about:blank"></iframe>
  </body>`, { url: "https://console.cloud.google.com/" });
  const frame = d.window.document.getElementById("pay");
  Object.defineProperty(frame, "contentDocument", {
    configurable: true,
    get() { throw new Error("cross-origin"); },
  });
  const { text } = core.buildSnapshot(d.window.document, d.window);
  assert.match(text, /iframe "https:\/\/payments\.google\.com\/payments\/u\/0\/documentcenter" \(cross-origin, not readable\)/);
  assert.doesNotMatch(text, /about:blank" \(cross-origin/);
  assert.equal(d.window.document.getElementById("blank").contentDocument != null, true);
});

test("focusAt blocks password fields and focuses a normal input", () => {
  const d = new JSDOM('<body><input id="pw" type="password"><input id="u"></body>', { url: "https://x.test/" });
  const doc = d.window.document;
  const pw = doc.getElementById("pw");
  const u = doc.getElementById("u");
  pw.focus();
  assert.throws(() => core.focusAt(d.window, { focused: true }), /password fields is blocked/);
  doc.elementFromPoint = () => u;
  const result = core.focusAt(d.window, { x: 10, y: 12 });
  assert.equal(doc.activeElement, u);
  assert.equal(result.tag, "input");
});

test("scrollBy scrolls the nearest inner panel under the viewport center", () => {
  const d = new JSDOM('<body><main style="overflow-y:auto"><section><button>Center</button></section></main></body>', { url: "https://app.test/" });
  const panel = d.window.document.querySelector("main");
  Object.defineProperties(panel, { scrollHeight: { value: 1800 }, clientHeight: { value: 400, configurable: true } });
  panel.scrollTop = 0;
  d.window.document.elementFromPoint = () => d.window.document.querySelector("button");
  const result = core.scrollBy(d.window, "down", 600);
  assert.equal(panel.scrollTop, 600);
  assert.equal(result.scrollTop, 600);
});


test("a deeply nested branch does not hide later page content", () => {
  const nested = '<div>'.repeat(401) + 'Too deep' + '</div>'.repeat(401);
  const d = new JSDOM(`<!doctype html><body>${nested}<main><button>Open report</button><p>Active users</p></main></body>`);
  const snap = core.buildSnapshot(d.window.document, d.window);
  assert.match(snap.text, /Open report/);
  assert.match(snap.text, /Active users/);
  assert.match(snap.text, /nesting\/size limit/);
});
