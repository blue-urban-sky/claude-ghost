import { test } from "node:test";
import * as assert from "node:assert/strict";
import { promptHash } from "../provider";

test("promptHash: identical inputs hash to the same value", () => {
  const s = "some prompt content — repeatable";
  assert.equal(promptHash(s), promptHash(s));
});

test("promptHash: empty string is stable", () => {
  assert.equal(promptHash(""), promptHash(""));
});

test("promptHash: different short strings produce different hashes", () => {
  assert.notEqual(promptHash("foo"), promptHash("bar"));
});

test("promptHash: length difference alone changes the hash", () => {
  // Same head and (empty) tail prefix; different length folded into material.
  assert.notEqual(promptHash("abc"), promptHash("abcd"));
});

test("promptHash: change within first 128 chars is detected", () => {
  const a = "A".repeat(1000);
  const b = "B" + "A".repeat(999);
  assert.notEqual(promptHash(a), promptHash(b));
});

test("promptHash: change within last 128 chars is detected", () => {
  const a = "A".repeat(1000);
  const b = "A".repeat(999) + "B";
  assert.notEqual(promptHash(a), promptHash(b));
});

test("promptHash: change in the middle (beyond head/tail window) may collide — that's expected", () => {
  // This is explicitly a cheap hash, not a crypto primitive. Document the
  // design: a change in the dead middle of a long prompt with identical head
  // and tail is permitted to collide. Hash equality here is the desired
  // behaviour, not a bug.
  const head = "H".repeat(128);
  const tail = "T".repeat(128);
  const a = head + "X".repeat(100) + tail;
  const b = head + "Y".repeat(100) + tail;
  assert.equal(promptHash(a), promptHash(b));
});

test("promptHash: returns a 32-bit integer", () => {
  const h = promptHash("hello world");
  assert.equal(Number.isInteger(h), true);
  assert.equal(h | 0, h);
});
