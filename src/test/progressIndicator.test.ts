import { test } from "node:test";
import * as assert from "node:assert/strict";
import { startProgressIndicator } from "../progressIndicator";

// Minimal editor / document stub. Only exercises the surface the indicator
// actually uses — setDecorations + lineAt + lineCount + uri.toString.

interface DecorationCall {
  type: object;
  ranges: Array<{ start: object; end: object }>;
}

function makeEditor(lineCount: number, lineLength: number): {
  editor: {
    document: {
      uri: { toString(): string };
      lineCount: number;
      lineAt(line: number): { range: { end: { line: number; character: number } } };
    };
    setDecorations(type: object, ranges: Array<{ start: object; end: object }>): void;
  };
  calls: DecorationCall[];
} {
  const calls: DecorationCall[] = [];
  return {
    editor: {
      document: {
        uri: { toString: () => "file:///stub" },
        lineCount,
        lineAt(line: number) {
          return { range: { end: { line, character: lineLength } } };
        },
      },
      setDecorations(type, ranges) {
        calls.push({ type, ranges });
      },
    },
    calls,
  };
}

// The module imports vscode; set up the shim via the same pattern used by
// the other tests. The register.ts harness does that for us at --require.

test("startProgressIndicator stops cleanly and clears decorations", () => {
  const { editor, calls } = makeEditor(5, 10);
  const indicator = startProgressIndicator(editor as any,2);
  // First apply happens synchronously.
  assert.ok(calls.length >= 1, "expected at least one setDecorations call at start");
  indicator.stop();
  // After stop, every decoration type should have been cleared to [].
  const clearCalls = calls.filter((c) => c.ranges.length === 0);
  assert.ok(clearCalls.length > 0, "expected clearing calls after stop");
});

test("startProgressIndicator places decoration at line end", () => {
  const { editor, calls } = makeEditor(5, 42);
  const indicator = startProgressIndicator(editor as any,3);
  const firstActive = calls.find((c) => c.ranges.length > 0);
  assert.ok(firstActive, "expected at least one active decoration");
  const end = firstActive!.ranges[0].end as { line: number; character: number };
  assert.equal(end.line, 3);
  assert.equal(end.character, 42);
  indicator.stop();
});

test("startProgressIndicator stop is idempotent", () => {
  const { editor } = makeEditor(3, 8);
  const indicator = startProgressIndicator(editor as any,0);
  indicator.stop();
  // Calling stop twice must not throw.
  assert.doesNotThrow(() => indicator.stop());
});
