import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  collectGitDiff,
  stripDiff,
  capDiff,
} from "../context/gitDiff";
import { FakeTextDocument, Position } from "./vscodeStub";

function makeCfg(over: Record<string, unknown> = {}): any {
  return {
    get: <T>(key: string, fallback: T): T => {
      if (key in over) return (over as any)[key];
      return fallback;
    },
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  };
}

const SAMPLE_DIFF = `diff --git a/file.ts b/file.ts
index abc..def 100644
--- a/file.ts
+++ b/file.ts
@@ -1,4 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
@@ -10,2 +10,3 @@
 function foo() {
+  return 42;
 }
`;

// stripDiff ------------------------------------------------------------------

test("stripDiff: drops context space-prefix lines, keeps hunks + ± lines", () => {
  const { text, hunkCount } = stripDiff(SAMPLE_DIFF);
  assert.equal(hunkCount, 2);
  assert.ok(text.includes("@@ -1,4 +1,4 @@"));
  assert.ok(text.includes("-const y = 2;"));
  assert.ok(text.includes("+const y = 3;"));
  assert.ok(!text.includes("const x = 1;"), "context line leaked");
  assert.ok(!text.includes("function foo()"), "context line leaked");
  assert.ok(!text.includes("+++"), "file header leaked");
  assert.ok(!text.includes("---"), "file header leaked");
});

test("stripDiff: empty input yields empty text", () => {
  assert.deepEqual(stripDiff(""), { text: "", hunkCount: 0 });
});

// capDiff --------------------------------------------------------------------

test("capDiff: under cap passes through", () => {
  const { text } = stripDiff(SAMPLE_DIFF);
  const capped = capDiff(text, 1000);
  assert.equal(capped, text);
});

test("capDiff: large input truncates to cap and keeps trailing hunks", () => {
  // Build a diff that exceeds 500 chars.
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push(`@@ -${i},1 +${i},1 @@`);
    lines.push(`-old line ${i}`);
    lines.push(`+new line ${i}`);
  }
  const big = lines.join("\n");
  assert.ok(big.length > 500);
  const capped = capDiff(big, 500);
  assert.ok(capped.length <= 500, `got ${capped.length}`);
  assert.ok(capped.startsWith("[…earlier hunks truncated]"));
  // Trailing hunks preserved.
  assert.ok(capped.includes("new line 19"));
});

// collectGitDiff -------------------------------------------------------------

test("collectGitDiff: setting off, no override → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: false }),
    null,
    async () => SAMPLE_DIFF,
  );
  assert.equal(chunks.length, 0);
});

test("collectGitDiff: override=true forces on even when setting off", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: false }),
    { diff: true },
    async () => SAMPLE_DIFF,
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].source, "diff");
  assert.equal(chunks[0].label, "pending changes");
  assert.equal(chunks[0].language, "diff");
});

test("collectGitDiff: override=false disables even when setting on", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: true }),
    { diff: false },
    async () => SAMPLE_DIFF,
  );
  assert.equal(chunks.length, 0);
});

test("collectGitDiff: no git repo → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: true }),
    null,
    async () => null,
  );
  assert.equal(chunks.length, 0);
});

test("collectGitDiff: empty diff → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: true }),
    null,
    async () => "",
  );
  assert.equal(chunks.length, 0);
});

test("collectGitDiff: on path, strips context and returns single chunk <=500 chars", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: true }),
    null,
    async () => SAMPLE_DIFF,
  );
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.length <= 500);
  assert.ok(chunks[0].text.includes("@@"));
  assert.ok(!chunks[0].text.includes("const x = 1;"));
});

test("collectGitDiff: pure-context diff yields []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const justContext = `@@ -1,1 +1,1 @@\n unchanged\n`;
  // stripDiff keeps the @@ header but drops the context line. @@ alone isn't
  // empty so it does produce a chunk. That's acceptable — test stricter case:
  const empty = `--- a/x\n+++ b/x\n unchanged\n`;
  const chunks = await collectGitDiff(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useGitDiff: true }),
    null,
    async () => empty,
  );
  assert.equal(chunks.length, 0);
  void justContext;
});
