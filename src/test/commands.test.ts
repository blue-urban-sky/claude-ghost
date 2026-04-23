import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseHintInput } from "../commands";

test("parseHintInput: empty input yields empty hint and no overrides", () => {
  const r = parseHintInput("");
  assert.equal(r.hint, "");
  assert.deepEqual(r.overrides, {});
  assert.equal(r.anyTokens, false);
});

test("parseHintInput: plain text with no tokens is passed through verbatim", () => {
  const r = parseHintInput("use a Map instead");
  assert.equal(r.hint, "use a Map instead");
  assert.deepEqual(r.overrides, {});
  assert.equal(r.anyTokens, false);
});

test("parseHintInput: single +symbols token sets override and strips", () => {
  const r = parseHintInput("+symbols use a Map instead");
  assert.equal(r.hint, "use a Map instead");
  assert.deepEqual(r.overrides, { symbols: true });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: multiple tokens, empty hint (one-shot context expansion)", () => {
  const r = parseHintInput("+visible +diff");
  assert.equal(r.hint, "");
  assert.deepEqual(r.overrides, { visible: true, diff: true });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: all four tokens recognised", () => {
  const r = parseHintInput("+visible +recent +symbols +diff");
  assert.equal(r.hint, "");
  assert.deepEqual(r.overrides, {
    visible: true,
    recent: true,
    symbols: true,
    diff: true,
  });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: tokens are case-insensitive", () => {
  const r = parseHintInput("+Visible +RECENT keep these on");
  assert.equal(r.hint, "keep these on");
  assert.deepEqual(r.overrides, { visible: true, recent: true });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: duplicate tokens collapse to a single true", () => {
  const r = parseHintInput("+visible +visible now do the thing");
  assert.equal(r.hint, "now do the thing");
  assert.deepEqual(r.overrides, { visible: true });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: unknown +token is treated as hint content, not stripped", () => {
  const r = parseHintInput("+foo do something");
  assert.equal(r.hint, "+foo do something");
  assert.deepEqual(r.overrides, {});
  assert.equal(r.anyTokens, false);
});

test("parseHintInput: known token followed by unknown token halts at unknown", () => {
  const r = parseHintInput("+visible +bar still hint");
  assert.equal(r.hint, "+bar still hint");
  assert.deepEqual(r.overrides, { visible: true });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: leading whitespace is tolerated", () => {
  const r = parseHintInput("   +recent   make it recursive");
  assert.equal(r.hint, "make it recursive");
  assert.deepEqual(r.overrides, { recent: true });
  assert.equal(r.anyTokens, true);
});

test("parseHintInput: bare +token with no trailing text", () => {
  const r = parseHintInput("+symbols");
  assert.equal(r.hint, "");
  assert.deepEqual(r.overrides, { symbols: true });
  assert.equal(r.anyTokens, true);
});
