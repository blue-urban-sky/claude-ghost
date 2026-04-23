import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  collectSymbols,
  _resetSymbolsCacheForTests,
  _symbolsCacheSize,
} from "../context/symbols";
import { FakeTextDocument, Position, Uri } from "./vscodeStub";

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

test("collectSymbols: returns [] when setting off and no override", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction(42);",
  );
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: false }),
    null,
    undefined,
    async () => [],
    async () => { throw new Error("should not open"); },
  );
  assert.equal(chunks.length, 0);
});

test("collectSymbols: override=true forces on", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction(42);",
  );
  const defDoc = new FakeTextDocument(
    "typescript",
    "/tmp/def.ts",
    "export const helperFunction = () => 1;",
  );
  let called = 0;
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: false }),
    { symbols: true },
    undefined,
    async () => {
      called++;
      return [{ uri: defDoc.uri, range: new (require("./vscodeStub").Range)(new Position(0, 0), new Position(0, 1)) }];
    },
    async () => defDoc as any,
  );
  assert.ok(called > 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].source, "symbols");
  assert.equal(chunks[0].label, "def.ts");
});

test("collectSymbols: override=false disables even with setting on", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction(42);",
  );
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: true }),
    { symbols: false },
    undefined,
    async () => { throw new Error("should not run"); },
    async () => { throw new Error("should not open"); },
  );
  assert.equal(chunks.length, 0);
});

test("collectSymbols: no identifiers -> returns []", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "1 + 2;\n");
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    undefined,
    async () => [],
    async () => { throw new Error("nope"); },
  );
  assert.equal(chunks.length, 0);
});

test("collectSymbols: tolerates empty/null LSP results", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction();",
  );
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 10) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    undefined,
    async () => null,
    async () => { throw new Error("should not open"); },
  );
  assert.equal(chunks.length, 0);
});

test("collectSymbols: cache hit avoids re-calling the command", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction(42);",
  );
  const defDoc = new FakeTextDocument(
    "typescript",
    "/tmp/def.ts",
    "export const helperFunction = () => 1;",
  );
  const { Range } = require("./vscodeStub");
  let calls = 0;
  const runner: any = async () => {
    calls++;
    return [{ uri: defDoc.uri, range: new Range(new Position(0, 0), new Position(0, 1)) }];
  };
  const opener: any = async () => defDoc;

  const first = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    undefined,
    runner,
    opener,
  );
  const callsAfterFirst = calls;
  const second = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    undefined,
    runner,
    opener,
  );
  assert.ok(first.length > 0);
  assert.equal(second.length, first.length);
  assert.equal(calls, callsAfterFirst, "second call should be all cache hits");
  assert.ok(_symbolsCacheSize() > 0);
});

test("collectSymbols: honours symbolResolutionMaxFiles cap", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "alpha bravo charlie delta echo foxtrot golf hotel",
  );
  const { Range } = require("./vscodeStub");
  const runner: any = async (_cmd: string, uri: any, pos: Position) => {
    // Return a unique def for each word's starting position.
    const word = (() => {
      const text = doc.lineAt(pos.line).text;
      const remainder = text.slice(pos.character);
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(remainder);
      return m ? m[0] : "x";
    })();
    return [{ uri: new Uri("file", `/tmp/${word}.ts`), range: new Range(new Position(0, 0), new Position(0, 1)) }];
  };
  const opener: any = async (uri: any) => {
    const name = uri.fsPath.split("/").pop();
    return new FakeTextDocument("typescript", uri.fsPath, `// ${name}`);
  };
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ useSymbolResolution: true, symbolResolutionMaxFiles: 3 }),
    null,
    undefined,
    runner,
    opener,
  );
  assert.equal(chunks.length, 3);
});

test("collectSymbols: skipUris omits URIs already included elsewhere", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction(42);",
  );
  const defDoc = new FakeTextDocument(
    "typescript",
    "/tmp/def.ts",
    "export const helperFunction = () => 1;",
  );
  const { Range } = require("./vscodeStub");
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    new Set([defDoc.uri.toString()]),
    async () => [{ uri: defDoc.uri, range: new Range(new Position(0, 0), new Position(0, 1)) }],
    async () => defDoc as any,
  );
  assert.equal(chunks.length, 0);
});

test("collectSymbols: normalises LocationLink return shape", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction();",
  );
  const defDoc = new FakeTextDocument(
    "typescript",
    "/tmp/def.ts",
    "export const helperFunction = () => 1;",
  );
  const { Range } = require("./vscodeStub");
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    undefined,
    async () => [{ targetUri: defDoc.uri, targetRange: new Range(new Position(0, 0), new Position(0, 1)) }],
    async () => defDoc as any,
  );
  assert.equal(chunks.length, 1);
});

test("collectSymbols: skips the current file's URI", async () => {
  _resetSymbolsCacheForTests();
  const doc = new FakeTextDocument(
    "typescript",
    "/tmp/a.ts",
    "const result = helperFunction();",
  );
  const { Range } = require("./vscodeStub");
  const chunks = await collectSymbols(
    doc as any,
    new Position(0, 15) as any,
    makeCfg({ useSymbolResolution: true }),
    null,
    undefined,
    async () => [{ uri: doc.uri, range: new Range(new Position(0, 0), new Position(0, 1)) }],
    async () => doc as any,
  );
  assert.equal(chunks.length, 0);
});
