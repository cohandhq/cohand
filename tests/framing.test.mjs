import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeNative, NativeDecoder, encodeLine, LineDecoder } from "../host/framing.mjs";

test("native round-trip", () => {
  const d = new NativeDecoder();
  assert.deepEqual(d.push(encodeNative({ a: 1 })), [{ a: 1 }]);
});
test("native frame split across 3 chunks", () => {
  const b = encodeNative({ hello: "world" });
  const d = new NativeDecoder();
  assert.deepEqual(d.push(b.subarray(0, 2)), []);
  assert.deepEqual(d.push(b.subarray(2, 6)), []);
  assert.deepEqual(d.push(b.subarray(6)), [{ hello: "world" }]);
});
test("two native frames in one chunk", () => {
  const d = new NativeDecoder();
  assert.deepEqual(d.push(Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: 2 })])), [{ a: 1 }, { b: 2 }]);
});
test("length prefix is little-endian", () => {
  assert.equal(encodeNative({}).readUInt32LE(0), 2);
});
test("native frame too large throws", () => {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(64 * 1024 * 1024 + 1);
  assert.throws(() => new NativeDecoder().push(h), /native frame too large/);
});
test("line decoder splits across chunks and reports malformed", () => {
  const d = new LineDecoder();
  assert.deepEqual(d.push('{"a":1}\n{"b'), [{ a: 1 }]);
  assert.deepEqual(d.push('":2}\n'), [{ b: 2 }]);
  const out = d.push("nope\n");
  assert.equal(out.length, 1);
  assert.ok(out[0].__error);
  assert.equal(encodeLine({ x: 1 }), '{"x":1}\n');
});
