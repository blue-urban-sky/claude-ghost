import { test } from "node:test";
import * as assert from "node:assert/strict";
import { cleanCompletion, commentMarkerFor, buildPrompt, findNearbyComment } from "../prompt";
import { FakeTextDocument, Position } from "./vscodeStub";

// cleanCompletion ------------------------------------------------------------

test("cleanCompletion strips scaffolding tags", () => {
  const raw = "<hint>foo</hint>const x = 1;<file>stuff</file>";
  assert.ok(!cleanCompletion(raw).includes("<hint>"));
  assert.ok(!cleanCompletion(raw).includes("<file>"));
  assert.ok(cleanCompletion(raw).includes("const x = 1;"));
});

test("cleanCompletion strips nonce-suffixed scaffolding tags", () => {
  const raw = "<file-abcd1234>content</file-abcd1234>real code";
  const out = cleanCompletion(raw);
  assert.ok(!out.includes("<file-abcd1234>"));
  assert.ok(out.includes("real code"));
});

test("cleanCompletion prefers fenced code block over surrounding prose", () => {
  const raw = "Here you go:\n```ts\nconst a = 1;\n```\nThat's it.";
  assert.equal(cleanCompletion(raw), "const a = 1;");
});

test("cleanCompletion preserves legitimate trailing function calls", () => {
  const raw = "const x = foo(bar, baz)";
  assert.equal(cleanCompletion(raw), raw);
});

test("cleanCompletion strips trailing meta commentary '(end of file)'", () => {
  const raw = "const x = 1;\n(end of file)";
  assert.equal(cleanCompletion(raw), "const x = 1;");
});

test("cleanCompletion strips '(no additional code needed)' meta comment", () => {
  const raw = "doStuff();\n(no additional code needed)";
  assert.ok(!cleanCompletion(raw).includes("no additional"));
  assert.ok(cleanCompletion(raw).includes("doStuff();"));
});

test("cleanCompletion keeps trailing '(continued below)' out (contains 'continued')", () => {
  const raw = "foo();\n(continued below)";
  assert.equal(cleanCompletion(raw), "foo();");
});

test("cleanCompletion preserves empty ish input", () => {
  assert.equal(cleanCompletion(""), "");
});

// commentMarkerFor -----------------------------------------------------------

test("commentMarkerFor known language ids", () => {
  assert.equal(commentMarkerFor("typescript"), "//");
  assert.equal(commentMarkerFor("python"), "#");
  assert.equal(commentMarkerFor("sql"), "--");
  assert.equal(commentMarkerFor("lua"), "--");
});

test("commentMarkerFor unknown language returns null", () => {
  assert.equal(commentMarkerFor("fortran"), null);
  assert.equal(commentMarkerFor(""), null);
});

// buildPrompt ----------------------------------------------------------------

test("buildPrompt embeds prefix/suffix around cursor marker", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "const a = 1;\nconst b = 2;");
  // Cursor at the end of line 0 (after `;`).
  const pos = new Position(0, 12);
  const prompt = buildPrompt(doc as any, pos as any, {
    contextMaxBytes: 1024,
    contextLines: 50,
  });
  assert.ok(prompt.includes("«CURSOR»"));
  assert.ok(/<file-[a-f0-9]+ /.test(prompt));
  assert.ok(prompt.includes("const a = 1;«CURSOR»"));
  assert.ok(prompt.includes("const b = 2;"));
});

test("buildPrompt includes hint when provided", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const prompt = buildPrompt(doc as any, new Position(0, 1) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    hint: "use async",
  });
  assert.ok(/<hint-[a-f0-9]+>use async<\/hint-[a-f0-9]+>/.test(prompt));
});

test("buildPrompt neutralises «CURSOR» leaked in file content", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "pre«CURSOR»mid");
  const prompt = buildPrompt(doc as any, new Position(0, 3) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
  });
  // Only one real «CURSOR» marker (no zwsp) should remain; the leaked one in
  // file content gets rewritten.
  const matches = prompt.match(/«CURSOR»/g) ?? [];
  assert.equal(matches.length, 1, `expected 1 raw cursor marker, got ${matches.length} in: ${prompt}`);
});

test("buildPrompt includes maximalist task tag", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const prompt = buildPrompt(doc as any, new Position(0, 1) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    maximalist: { task: "build a CRUD" },
  });
  assert.ok(/<task-[a-f0-9]+>build a CRUD<\/task-[a-f0-9]+>/.test(prompt));
});

// findNearbyComment ----------------------------------------------------------

test("findNearbyComment finds single-line // comment directly above cursor", () => {
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "// make a counter\n",
  );
  const task = findNearbyComment(doc as any, new Position(1, 0) as any);
  assert.equal(task, "make a counter");
});

test("findNearbyComment joins multi-line comment block", () => {
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "// first line\n// second line\n",
  );
  const task = findNearbyComment(doc as any, new Position(2, 0) as any);
  assert.equal(task, "first line second line");
});

test("findNearbyComment returns null for unknown language", () => {
  const doc = new FakeTextDocument("fortran", "/tmp/a.f", "! comment\n");
  assert.equal(findNearbyComment(doc as any, new Position(1, 0) as any), null);
});

test("findNearbyComment returns null when cursor too far from comment", () => {
  const body = "// hi\n" + "\n".repeat(20);
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", body);
  const task = findNearbyComment(doc as any, new Position(20, 0) as any);
  assert.equal(task, null);
});
