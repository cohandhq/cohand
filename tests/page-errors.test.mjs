import { test } from "node:test";
import assert from "node:assert/strict";
import { describePageError, isPageErrorMessage } from "../extension/lib/page-errors.js";

const CHROME_ERROR = "Frame with ID 0 is showing error page";

test("a Chrome error page on localhost names the URL and the tunnel workaround", () => {
  const got = describePageError(CHROME_ERROR, "http://localhost:5173/");
  assert.match(got, /http:\/\/localhost:5173\//);
  assert.match(got, /cloudflared tunnel --url http:\/\/localhost:5173\//);
  assert.match(got, /https/i);
  assert.match(got, /docs\/ISSUES\.md #31/);
  assert.ok(got.endsWith(CHROME_ERROR), "keeps Chrome's own text at the end");
});

test("loopback forms (127.0.0.1, [::1], private LAN) all get the tunnel hint", () => {
  for (const url of ["http://127.0.0.1:5173/", "http://[::1]:5173/", "http://192.168.1.20:8080/", "localhost:5173"]) {
    const got = describePageError(CHROME_ERROR, url);
    assert.match(got, /cloudflared tunnel --url/, `expected hint for ${url}`);
  }
});

test("an ERR_ code is recognized as an error page", () => {
  assert.equal(isPageErrorMessage("net::ERR_CONNECTION_REFUSED"), true);
  const got = describePageError("net::ERR_CONNECTION_REFUSED", "https://example.com/");
  assert.match(got, /https:\/\/example\.com\//);
  assert.ok(got.endsWith("net::ERR_CONNECTION_REFUSED"));
});

test("a chrome-error:// message is recognized", () => {
  assert.equal(isPageErrorMessage("Cannot access contents of url \"chrome-error://chromewebdata/\""), true);
});

test("a chrome-error:// tab URL still gets the loopback workaround hint", () => {
  const got = describePageError(CHROME_ERROR, "chrome-error://chromewebdata/");
  assert.match(got, /cloudflared/);
  assert.ok(got.endsWith(CHROME_ERROR));
});

test("ordinary failures pass through unchanged", () => {
  for (const message of [
    "stale snapshot: ref e5 not found",
    "no response from page",
    "blocked: ask-first denied",
    "page load timeout",
  ]) {
    assert.equal(describePageError(message, "http://localhost:5173/"), message);
  }
  assert.equal(isPageErrorMessage("stale snapshot: ref e5 not found"), false);
});

test("an empty url still yields a usable message", () => {
  for (const url of [undefined, null, "", "   "]) {
    const got = describePageError(CHROME_ERROR, url);
    assert.match(got, /Chrome could not load the requested page/);
    assert.match(got, /check the URL and network access/);
    assert.match(got, /cloudflared/, "unknown URL still mentions the loopback workaround");
    assert.ok(got.endsWith(CHROME_ERROR));
  }
});
