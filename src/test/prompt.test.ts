import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  cleanCompletion,
  commentMarkerFor,
  buildPrompt,
  completionOverlap,
  findNearbyComment,
  languageStyleFor,
} from "../prompt";
import { FakeTextDocument, Position } from "./vscodeStub";

// completionOverlap ----------------------------------------------------------

test("completionOverlap: no overlap when completion doesn't echo any trailing text", () => {
  // Mongo-helpers case: cursor sits between `extends ` and `>(fields: T)…`;
  // completion is `"Document"`. No tail of completion matches head of after.
  assert.equal(completionOverlap("Document", ">(fields: T): { $set }"), 0);
});

test("completionOverlap: single trailing paren echo", () => {
  // Classic `foo(` case — editor auto-inserts `)`, completion re-emits it.
  assert.equal(completionOverlap("bar)", ")"), 1);
});

test("completionOverlap: multi-char tail match", () => {
  assert.equal(completionOverlap("return done;", "done;"), 5);
});

test("completionOverlap: full after-content match", () => {
  assert.equal(completionOverlap("foo bar baz", " baz"), 4);
});

test("completionOverlap: empty after yields 0", () => {
  assert.equal(completionOverlap("anything", ""), 0);
});

test("completionOverlap: empty completion yields 0", () => {
  assert.equal(completionOverlap("", "xyz"), 0);
});

test("completionOverlap: prefers longest suffix that matches a prefix of after", () => {
  // "aba" ends with "aba", "ba", "a". After starts with "a". Expect 1.
  assert.equal(completionOverlap("aba", "a"), 1);
  // After starts with "ab". Tail "ab" of "aab" matches. Expect 2.
  assert.equal(completionOverlap("aab", "ab"), 2);
});

test("completionOverlap: does not match interior", () => {
  // "xyz" in middle of completion shouldn't count.
  assert.equal(completionOverlap("foo xyz bar", "xyz"), 0);
});

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

// languageStyleFor ----------------------------------------------------------

test("languageStyleFor: typescript returns non-empty", () => {
  assert.ok(languageStyleFor("typescript").length > 0);
});

test("languageStyleFor: typescriptreact returns non-empty", () => {
  assert.ok(languageStyleFor("typescriptreact").length > 0);
});

test("languageStyleFor: javascript returns non-empty", () => {
  assert.ok(languageStyleFor("javascript").length > 0);
});

test("languageStyleFor: javascriptreact returns non-empty", () => {
  assert.ok(languageStyleFor("javascriptreact").length > 0);
});

test("languageStyleFor: python returns non-empty", () => {
  assert.ok(languageStyleFor("python").length > 0);
});

test("languageStyleFor: java returns non-empty", () => {
  assert.ok(languageStyleFor("java").length > 0);
});

test("languageStyleFor: kotlin returns non-empty", () => {
  assert.ok(languageStyleFor("kotlin").length > 0);
});

test("languageStyleFor: go returns non-empty", () => {
  assert.ok(languageStyleFor("go").length > 0);
});

test("languageStyleFor: shellscript returns non-empty", () => {
  assert.ok(languageStyleFor("shellscript").length > 0);
});

test("languageStyleFor: terraform returns non-empty", () => {
  assert.ok(languageStyleFor("terraform").length > 0);
});

test("languageStyleFor: unknown languageId returns empty string", () => {
  assert.equal(languageStyleFor("somethingweird"), "");
});

// buildPrompt — style block --------------------------------------------------

test("buildPrompt includes <style lang=\"typescript\"> when languageId is typescript", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const prompt = buildPrompt(doc as any, new Position(0, 1) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    languageId: "typescript",
  });
  assert.ok(/<style lang="typescript">[^<]+<\/style>/.test(prompt));
});

test("buildPrompt omits <style> block when languageId is unknown", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const prompt = buildPrompt(doc as any, new Position(0, 1) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    languageId: "whatever",
  });
  assert.ok(!prompt.includes("<style"));
});

// buildPrompt — extraContext -------------------------------------------------

test("buildPrompt renders extraContext chunks with proper nonce-escaped boundaries", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "const x = 1;");
  const prompt = buildPrompt(doc as any, new Position(0, 12) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    extraContext: [
      {
        source: "visible",
        label: "other.ts",
        language: "typescript",
        text: "export const helper = () => 42;",
      },
    ],
  });
  // The extra chunk uses the same per-request nonce and role="context".
  const match = prompt.match(/<file-([a-f0-9]+) name="other\.ts" language="typescript" role="context">\nexport const helper = \(\) => 42;\n<\/file-\1>/);
  assert.ok(match, `expected extra context file envelope, got: ${prompt}`);
  // Ensure the current file envelope uses the same nonce.
  assert.ok(prompt.includes(`<file-${match![1]} name="a.ts" language="typescript">`));
});

test("buildPrompt with empty extraContext is identical to without the param", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "const x = 1;");
  // The nonce is random per-call, so comparing whole strings is flaky. Instead
  // check that the extra-chunk envelope never appears and structure matches.
  const promptA = buildPrompt(doc as any, new Position(0, 12) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
  });
  const promptB = buildPrompt(doc as any, new Position(0, 12) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    extraContext: [],
  });
  // Neither output should include a context-role file envelope.
  assert.ok(!promptA.includes("role=\"context\""));
  assert.ok(!promptB.includes("role=\"context\""));
  // Strip nonce and compare structure.
  const stripNonce = (s: string) => s.replace(/-[a-f0-9]{8}/g, "-NONCE");
  assert.equal(stripNonce(promptA), stripNonce(promptB));
});

test("buildPrompt neutralises <file and nonce leakage in extraContext text", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const prompt = buildPrompt(doc as any, new Position(0, 1) as any, {
    contextMaxBytes: 1024,
    contextLines: 10,
    extraContext: [
      {
        source: "visible",
        label: "hostile.ts",
        language: "typescript",
        text: "«CURSOR» leaked",
      },
    ],
  });
  // Exactly one raw cursor marker: the real one in the current file.
  const matches = prompt.match(/«CURSOR»/g) ?? [];
  assert.equal(matches.length, 1, `expected 1 raw cursor marker, got ${matches.length} in: ${prompt}`);
});
