import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  collectVisibleRecent,
  recordRecentEdit,
  _resetRecentRingBufferForTests,
  getRecentRingBuffer,
} from "../context/visibleRecent";
import { FakeTextDocument, Position, Uri } from "./vscodeStub";

// Build a WorkspaceConfiguration-ish object keyed on plain entries.
interface CfgShape {
  extraContext?: "off" | "recent" | "visible" | "visible+recent";
  extraContextMaxBytes?: number;
}
function makeCfg(over: CfgShape = {}): any {
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

test("collectVisibleRecent: returns [] when setting off and no overrides", async () => {
  _resetRecentRingBufferForTests();
  const doc = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const chunks = await collectVisibleRecent(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "off" }),
    null,
  );
  assert.equal(chunks.length, 0);
});

test("collectVisibleRecent: override forces on even when setting off", async () => {
  _resetRecentRingBufferForTests();
  const doc = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const other = new FakeTextDocument("typescript", "/tmp/b.ts", "export const b = 1;");
  const chunks = await collectVisibleRecent(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "off" }),
    { visible: true },
    {
      visibleEditors: () => [{ document: other } as any],
    },
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].source, "visible");
  assert.equal(chunks[0].label, "/tmp/b.ts".split("/").pop());
});

test("collectVisibleRecent: override visible=false disables even when setting on", async () => {
  _resetRecentRingBufferForTests();
  const doc = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const other = new FakeTextDocument("typescript", "/tmp/b.ts", "y");
  const chunks = await collectVisibleRecent(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "visible" }),
    { visible: false },
    { visibleEditors: () => [{ document: other } as any] },
  );
  assert.equal(chunks.length, 0);
});

test("collectVisibleRecent: skips active editor when mode=visible", async () => {
  _resetRecentRingBufferForTests();
  const doc = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const chunks = await collectVisibleRecent(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "visible" }),
    null,
    { visibleEditors: () => [{ document: doc } as any] },
  );
  assert.equal(chunks.length, 0);
});

test("collectVisibleRecent: caps visible tabs at 3", async () => {
  _resetRecentRingBufferForTests();
  const doc = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const tabs = [1, 2, 3, 4, 5].map(
    (i) => new FakeTextDocument("typescript", `/tmp/t${i}.ts`, `const t${i} = 1;`),
  );
  const chunks = await collectVisibleRecent(
    doc as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "visible" }),
    null,
    { visibleEditors: () => tabs.map((d) => ({ document: d }) as any) },
  );
  assert.equal(chunks.length, 3);
});

test("collectVisibleRecent: recent mode pulls ring buffer; skips active", async () => {
  _resetRecentRingBufferForTests();
  const active = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const a = new FakeTextDocument("typescript", "/tmp/a.ts", "const a = 1;");
  const b = new FakeTextDocument("typescript", "/tmp/b.ts", "const b = 1;");
  recordRecentEdit(active as any);
  recordRecentEdit(a as any);
  recordRecentEdit(b as any);
  // Ring buffer includes active — but active should be skipped by collect.
  assert.ok(getRecentRingBuffer().length >= 2);

  const docMap: Record<string, FakeTextDocument> = {
    [active.uri.toString()]: active,
    [a.uri.toString()]: a,
    [b.uri.toString()]: b,
  };
  const chunks = await collectVisibleRecent(
    active as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "recent" }),
    null,
    { openTextDocument: async (uri: any) => docMap[uri.toString()] as any },
  );
  const labels = chunks.map((c) => c.label).sort();
  assert.deepEqual(labels, ["a.ts", "b.ts"]);
  chunks.forEach((c) => assert.equal(c.source, "recent"));
});

test("collectVisibleRecent: dedupes visible vs recent", async () => {
  _resetRecentRingBufferForTests();
  const active = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const shared = new FakeTextDocument("typescript", "/tmp/shared.ts", "export const s = 1;");
  recordRecentEdit(shared as any);
  const chunks = await collectVisibleRecent(
    active as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "visible+recent" }),
    null,
    {
      visibleEditors: () => [{ document: shared } as any],
      openTextDocument: async () => shared as any,
    },
  );
  assert.equal(chunks.length, 1);
  // Visible wins — it's seen first.
  assert.equal(chunks[0].source, "visible");
});

test("collectVisibleRecent: byte budget drops lowest-priority first", async () => {
  _resetRecentRingBufferForTests();
  const active = new FakeTextDocument("typescript", "/tmp/active.ts", "x");
  const big = "a".repeat(200);
  const tabs = [
    new FakeTextDocument("typescript", "/tmp/t1.ts", big),
    new FakeTextDocument("typescript", "/tmp/t2.ts", big),
    new FakeTextDocument("typescript", "/tmp/t3.ts", big),
  ];
  const chunks = await collectVisibleRecent(
    active as any,
    new Position(0, 0) as any,
    makeCfg({ extraContext: "visible", extraContextMaxBytes: 450 }),
    null,
    { visibleEditors: () => tabs.map((d) => ({ document: d }) as any) },
  );
  // 3 * 200 = 600 > 450, so at least one must drop.
  const total = chunks.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
  assert.ok(total <= 450, `budget breached: ${total}`);
  assert.ok(chunks.length < 3);
});

test("recordRecentEdit: dedupes repeated edits (most recent wins)", () => {
  _resetRecentRingBufferForTests();
  const a = new FakeTextDocument("typescript", "/tmp/a.ts", "x");
  const b = new FakeTextDocument("typescript", "/tmp/b.ts", "x");
  recordRecentEdit(a as any);
  recordRecentEdit(b as any);
  recordRecentEdit(a as any);
  const buf = getRecentRingBuffer();
  assert.equal(buf[0], a.uri.toString());
  assert.equal(buf[1], b.uri.toString());
  assert.equal(buf.length, 2);
});

test("recordRecentEdit: cap at 5 entries", () => {
  _resetRecentRingBufferForTests();
  for (let i = 0; i < 10; i++) {
    recordRecentEdit(new FakeTextDocument("typescript", `/tmp/f${i}.ts`, "x") as any);
  }
  assert.equal(getRecentRingBuffer().length, 5);
});

void Uri; // silence unused warning
