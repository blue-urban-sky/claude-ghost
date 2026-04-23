import { test } from "node:test";
import * as assert from "node:assert/strict";
import { assembleExtraContext } from "../context";
import { FakeTextDocument, Position } from "./vscodeStub";

// Minimal shim for vscode.WorkspaceConfiguration — the stub assembler
// ignores the cfg entirely for Wave 1, so a no-op object is enough.
const fakeCfg = {
  get: <T>(_key: string, fallback: T): T => fallback,
  has: () => false,
  inspect: () => undefined,
  update: async () => undefined,
};

test("assembleExtraContext returns [] in Wave 1 (stub)", () => {
  const doc = new FakeTextDocument("typescript", "/tmp/a.ts", "const x = 1;");
  const chunks = assembleExtraContext(doc as any, new Position(0, 0) as any, fakeCfg as any);
  assert.equal(Array.isArray(chunks), true);
  assert.equal(chunks.length, 0);
});
