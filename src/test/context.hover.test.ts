import { test } from "node:test";
import * as assert from "node:assert/strict";
import { collectHover, stripFences } from "../context/hover";
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

// stripFences ----------------------------------------------------------------

test("stripFences: extracts body from fenced block", () => {
  const out = stripFences("```typescript\nconst x: number = 1;\n```");
  assert.equal(out, "const x: number = 1;");
});

test("stripFences: passes through plain markdown", () => {
  assert.equal(stripFences("some type info"), "some type info");
});

// collectHover ---------------------------------------------------------------

test("collectHover: setting off → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "user.name");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any, // just after "."
    makeCfg({ useTypeInfo: false }),
    null,
    async () => [{ contents: ["string"] }],
  );
  assert.equal(chunks.length, 0);
});

test("collectHover: unsupported languageId → []", async () => {
  const doc = new FakeTextDocument("yaml", "/tmp/a.yaml", "foo:");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 4) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => [{ contents: ["string"] }],
  );
  assert.equal(chunks.length, 0);
});

test("collectHover: no accessor before cursor → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "const x = 1;");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 12) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => {
      throw new Error("should not run");
    },
  );
  assert.equal(chunks.length, 0);
});

test("collectHover: fires on `.` accessor", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "user.");
  let calledWith: any = null;
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async (_cmd: string, _uri: any, pos: any) => {
      calledWith = pos;
      return [{ contents: [{ value: "```typescript\n(var) user: { name: string }\n```" }] }];
    },
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].source, "hover");
  assert.equal(chunks[0].label, "receiver type");
  assert.equal(chunks[0].language, "typescript");
  assert.ok(chunks[0].text.includes("user"));
  // Confirmed we resolved the identifier at the start of "user", not at the accessor.
  assert.equal(calledWith.character, 0);
});

test("collectHover: fires on `->` accessor", async () => {
  const doc = new FakeTextDocument("go", "/tmp/a.go", "ptr->");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => [{ contents: ["*MyStruct"] }],
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "*MyStruct");
});

test("collectHover: fires on `::` accessor", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "Foo::");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => [{ contents: ["class Foo"] }],
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "class Foo");
});

test("collectHover: respects 500-char cap", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "user.");
  const big = "a".repeat(1000);
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => [{ contents: [big] }],
  );
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.length <= 500);
});

test("collectHover: empty hover response → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "user.");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => [],
  );
  assert.equal(chunks.length, 0);
});

test("collectHover: hover command throwing is swallowed", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "user.");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 5) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => {
      throw new Error("no provider");
    },
  );
  assert.equal(chunks.length, 0);
});

test("collectHover: no identifier before accessor (e.g. `.` at start of line) → []", async () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", ".");
  const chunks = await collectHover(
    doc as any,
    new Position(0, 1) as any,
    makeCfg({ useTypeInfo: true }),
    null,
    async () => [{ contents: ["shouldn't be called"] }],
  );
  assert.equal(chunks.length, 0);
});
