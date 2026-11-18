import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  notifications: {
    onButtonClicked: { addListener() {}, removeListener() {} },
    onClosed: { addListener() {}, removeListener() {} },
    create() {}, clear() {},
  },
};
const { askUser, listAsks, resolveAsk } = await import("../extension/lib/ask.js");

test("popup can resolve a pending ask by id; first answer wins", async () => {
  const p = askUser("agent: click on a.com", 5000, "a1");
  assert.deepEqual(listAsks().map((a) => [a.id, a.summary]), [["a1", "agent: click on a.com"]]);
  assert.equal(resolveAsk("a1", true), true);
  assert.deepEqual(await p, { allow: true });
  assert.equal(resolveAsk("a1", false), false);
  assert.equal(listAsks().length, 0);
});
