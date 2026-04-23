import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMetricsRecorder,
  type CompletionEvent,
} from "../metrics";
import type { Logger } from "../log";

function makeLogger(): Logger {
  const logs: string[] = [];
  const channel = {
    appendLine: (_msg: string): void => undefined,
    dispose: (): void => undefined,
  } as unknown as import("vscode").OutputChannel;
  return {
    log: (msg: string): void => {
      logs.push(msg);
    },
    sessionAppend: (): void => undefined,
    showError: (): void => undefined,
    mainChannel: channel,
    sessionChannel: channel,
    dispose: (): void => undefined,
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-ghost-metrics-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(p: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return;
    await sleep(20);
  }
}

function sampleEvent(overrides: Partial<CompletionEvent> = {}): CompletionEvent {
  return {
    ts: new Date().toISOString(),
    model: "haiku",
    effort: "low",
    languageId: "typescript",
    ttftMs: 500,
    totalMs: 1000,
    completionLen: 42,
    outcome: "accepted",
    ...overrides,
  };
}

test("metrics: record is a no-op when disabled", async () => {
  const dir = makeTmpDir();
  try {
    const recorder = createMetricsRecorder(() => false, makeLogger(), dir);
    recorder.record(sampleEvent());
    await sleep(50);
    assert.equal(fs.existsSync(path.join(dir, "metrics.jsonl")), false);
  } finally {
    cleanDir(dir);
  }
});

test("metrics: record when enabled writes valid JSONL", async () => {
  const dir = makeTmpDir();
  try {
    const recorder = createMetricsRecorder(() => true, makeLogger(), dir);
    const event = sampleEvent({ completionLen: 7 });
    recorder.record(event);
    const filePath = path.join(dir, "metrics.jsonl");
    await waitForFile(filePath);
    const text = await fsp.readFile(filePath, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as CompletionEvent;
    assert.equal(parsed.completionLen, 7);
    assert.equal(parsed.outcome, "accepted");
    assert.equal(parsed.model, "haiku");
  } finally {
    cleanDir(dir);
  }
});

test("metrics: rotates when file exceeds threshold", async () => {
  const dir = makeTmpDir();
  try {
    const recorder = createMetricsRecorder(
      () => true,
      makeLogger(),
      dir,
      { rotateBytes: 200 },
    );
    // Each event JSON line is ~140 chars; two events will exceed 200 bytes and trigger rotation.
    recorder.record(sampleEvent({ completionLen: 1 }));
    const filePath = path.join(dir, "metrics.jsonl");
    await waitForFile(filePath);
    // Append several more to ensure rotation fires at least once.
    for (let i = 0; i < 5; i++) {
      recorder.record(sampleEvent({ completionLen: i }));
      await sleep(20);
    }
    await sleep(100);
    const rotatedPath = path.join(dir, "metrics.jsonl.1");
    assert.equal(fs.existsSync(rotatedPath), true, "rotated file should exist");
  } finally {
    cleanDir(dir);
  }
});

test("metrics: summary on missing file returns zero-filled", async () => {
  const dir = makeTmpDir();
  try {
    const recorder = createMetricsRecorder(() => true, makeLogger(), dir);
    const summary = await recorder.summary(24);
    assert.equal(summary.totalCompletions, 0);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.acceptRate, 0);
    assert.equal(summary.p50TtftMs, 0);
    assert.equal(summary.p95TtftMs, 0);
    assert.equal(summary.avgTtftMs, 0);
  } finally {
    cleanDir(dir);
  }
});

test("metrics: summary counts outcomes correctly", async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, "metrics.jsonl");
    const now = Date.now();
    const iso = (offsetMs: number): string =>
      new Date(now - offsetMs).toISOString();
    const lines = [
      JSON.stringify(sampleEvent({ ts: iso(1000), outcome: "accepted", ttftMs: 100 })),
      JSON.stringify(sampleEvent({ ts: iso(2000), outcome: "accepted", ttftMs: 200 })),
      JSON.stringify(sampleEvent({ ts: iso(3000), outcome: "partial", ttftMs: 300 })),
      JSON.stringify(sampleEvent({ ts: iso(4000), outcome: "declined", ttftMs: 400, declineReason: "cursor moved" })),
      JSON.stringify(sampleEvent({ ts: iso(5000), outcome: "cancelled", ttftMs: 500 })),
      JSON.stringify(sampleEvent({ ts: iso(6000), outcome: "failed", ttftMs: -1 })),
      JSON.stringify(sampleEvent({ ts: iso(7000), outcome: "empty", ttftMs: -1 })),
    ];
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const recorder = createMetricsRecorder(() => true, makeLogger(), dir);
    const summary = await recorder.summary(24);
    assert.equal(summary.totalCompletions, 7);
    assert.equal(summary.accepted, 2);
    assert.equal(summary.partial, 1);
    assert.equal(summary.declined, 1);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.empty, 1);
    // (accepted + partial) / total = 3/7
    assert.ok(Math.abs(summary.acceptRate - 3 / 7) < 1e-9);
  } finally {
    cleanDir(dir);
  }
});

test("metrics: summary computes p50/p95 on latencies skipping -1", async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, "metrics.jsonl");
    const now = Date.now();
    const lines: string[] = [];
    // ttfts: 100..2000 step 100 (20 values) plus two -1 entries that should be skipped.
    for (let i = 1; i <= 20; i++) {
      lines.push(
        JSON.stringify(
          sampleEvent({
            ts: new Date(now - i * 100).toISOString(),
            ttftMs: i * 100,
            outcome: "accepted",
          }),
        ),
      );
    }
    lines.push(JSON.stringify(sampleEvent({ ttftMs: -1, outcome: "failed" })));
    lines.push(JSON.stringify(sampleEvent({ ttftMs: -1, outcome: "empty" })));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const recorder = createMetricsRecorder(() => true, makeLogger(), dir);
    const summary = await recorder.summary(24);
    // Nearest-rank: p50 over 20 sorted values = values[ceil(0.5*20)-1] = values[9] = 1000
    assert.equal(summary.p50TtftMs, 1000);
    // p95 = values[ceil(0.95*20)-1] = values[18] = 1900
    assert.equal(summary.p95TtftMs, 1900);
  } finally {
    cleanDir(dir);
  }
});

test("metrics: summary ignores unparseable lines", async () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, "metrics.jsonl");
    const now = Date.now();
    const lines = [
      "not json at all",
      JSON.stringify(sampleEvent({ ts: new Date(now).toISOString(), outcome: "accepted" })),
      "{ partial json",
      JSON.stringify(sampleEvent({ ts: new Date(now - 100).toISOString(), outcome: "declined" })),
      "",
    ];
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const recorder = createMetricsRecorder(() => true, makeLogger(), dir);
    const summary = await recorder.summary(24);
    assert.equal(summary.totalCompletions, 2);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.declined, 1);
  } finally {
    cleanDir(dir);
  }
});
