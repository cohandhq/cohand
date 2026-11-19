import { test } from "node:test";
import assert from "node:assert/strict";
import { clickRef } from "../extension/lib/click.js";
import { isMissingContentScript, retryInjected } from "../extension/lib/page-call.js";

const dispatched = (flag) => Object.assign(new Error("Input.dispatchMouseEvent failed"), { dispatched: flag });

test("ref click does not repeat through the DOM after CDP dispatched", async () => {
  const sent = [];
  const error = dispatched(true);
  await assert.rejects(
    clickRef({ id: 9 }, "e12", {
      click: async () => { throw error; },
      send: async (cmd) => { sent.push(cmd); return { x: 1, y: 2 }; },
    }),
    /dispatchMouseEvent/,
  );
  assert.deepEqual(sent, ["rect"], "only the rect lookup ran — no DOM click");
});

test("ref click falls back to the DOM only when no mouse event was dispatched", async () => {
  const sent = [];
  const result = await clickRef({ id: 9 }, "e12", {
    click: async () => { throw dispatched(false); },
    send: async (cmd) => { sent.push(cmd); return cmd === "rect" ? { x: 1, y: 2 } : { clicked: true }; },
  });
  assert.deepEqual(sent, ["rect", "click"]);
  assert.deepEqual(result, { clicked: true });
});

test("a page error is thrown once, without re-injecting and re-sending", async () => {
  let sends = 0;
  let injections = 0;
  await assert.rejects(
    retryInjected(
      async () => { sends++; throw new Error("policy blocked: ask-first denied"); },
      async () => { injections++; },
    ),
    /policy blocked/,
  );
  assert.equal(sends, 1);
  assert.equal(injections, 0);
});

test("a missing content script is injected once and the command retried", async () => {
  let sends = 0;
  let injections = 0;
  const result = await retryInjected(
    async () => {
      sends++;
      if (sends === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true };
    },
    async () => { injections++; },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(sends, 2);
  assert.equal(injections, 1);
});

test("only missing-content-script messages are retryable", () => {
  assert.equal(isMissingContentScript("Could not establish connection. Receiving end does not exist."), true);
  assert.equal(isMissingContentScript("Could not establish connection"), true);
  assert.equal(isMissingContentScript("no response from page"), true);
  for (const message of ["stale snapshot: ref e5 not found", "page load timeout", "action failed"]) {
    assert.equal(isMissingContentScript(message), false, message);
  }
});
