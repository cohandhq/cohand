import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { encodeFrame, decodeFrame, validateHello, MAX_FRAME_BYTES } = require("../shared/protocol.mjs");

const config = JSON.parse(readFileSync(new URL("../shared/config.json", import.meta.url), "utf8"));
const TOKEN = "a".repeat(64);

test("encode/decode round-trips a cmd frame", () => {
  const s = encodeFrame({ v: 1, id: 7, type: "cmd", cmd: "open", args: { url: "https://x.test" } });
  const r = decodeFrame(s);
  assert.equal(r.ok, true);
  assert.equal(r.frame.cmd, "open");
  assert.equal(r.frame.args.url, "https://x.test");
});

test("decode rejects malformed JSON", () => {
  const r = decodeFrame("{not json");
  assert.equal(r.ok, false);
  assert.match(r.error, /malformed/i);
});

test("decode rejects oversized frames", () => {
  const big = encodeFrame({ v: 1, type: "event", event: "log", data: { blob: "x".repeat(MAX_FRAME_BYTES) } });
  const r = decodeFrame(big);
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/i);
});

test("decode rejects non-object JSON", () => {
  assert.equal(decodeFrame('"just a string"').ok, false);
  assert.equal(decodeFrame("42").ok, false);
});

test("validateHello accepts correct token and version", () => {
  const r = validateHello({ v: config.protocolVersion, type: "hello", token: TOKEN, profile: "p1" }, { token: TOKEN, protocolVersion: config.protocolVersion });
  assert.equal(r.ok, true);
});

test("validateHello rejects wrong token", () => {
  const r = validateHello({ v: config.protocolVersion, type: "hello", token: "b".repeat(64), profile: "p1" }, { token: TOKEN, protocolVersion: config.protocolVersion });
  assert.equal(r.ok, false);
  assert.match(r.error, /token/i);
});

test("validateHello rejects wrong version", () => {
  const r = validateHello({ v: 99, type: "hello", token: TOKEN, profile: "p1" }, { token: TOKEN, protocolVersion: config.protocolVersion });
  assert.equal(r.ok, false);
  assert.match(r.error, /version/i);
});

test("validateHello rejects non-hello frames", () => {
  const r = validateHello({ v: config.protocolVersion, type: "cmd", token: TOKEN }, { token: TOKEN, protocolVersion: config.protocolVersion });
  assert.equal(r.ok, false);
  assert.match(r.error, /hello/i);
});

test("encodeFrame rejects non-serializable input", () => {
  assert.throws(() => encodeFrame({ v: 1, type: "cmd", fn: () => {} }));
});
