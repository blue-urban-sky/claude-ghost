import { test } from "node:test";
import * as assert from "node:assert/strict";
import { formatJsonlLine } from "../tailer";

test("formatJsonlLine formats assistant text blocks", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hi there" }] },
  });
  const out = formatJsonlLine(line);
  assert.ok(out?.includes("ASSISTANT"));
  assert.ok(out?.includes("hi there"));
});

test("formatJsonlLine formats system/init line", () => {
  const line = JSON.stringify({ type: "system", subtype: "init" });
  const out = formatJsonlLine(line);
  assert.equal(out, "── system/? ──".replace("?", "init"));
});

test("formatJsonlLine condenses user CURSOR request", () => {
  const user = [
    "<hint-abc123>do the thing</hint-abc123>",
    '<file-abc123 name="a.ts" language="typescript">',
    "prefix«CURSOR»suffix",
    "</file-abc123>",
  ].join("\n");
  const line = JSON.stringify({
    type: "user",
    message: { content: [{ type: "text", text: user }] },
  });
  const out = formatJsonlLine(line);
  assert.ok(out?.startsWith("\n── USER ──"));
  assert.ok(out?.includes("<hint-abc123>"));
  assert.ok(out?.includes("<file-abc123"));
  assert.ok(out?.includes("prefix«CURSOR»suffix"));
});

test("formatJsonlLine returns null on malformed JSON", () => {
  assert.equal(formatJsonlLine("not json"), null);
});

test("formatJsonlLine returns null on unknown type", () => {
  assert.equal(formatJsonlLine(JSON.stringify({ type: "unknown" })), null);
});
