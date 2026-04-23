import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "./log";

export type CompletionOutcome =
  | "accepted"
  | "partial"
  | "declined"
  | "cancelled"
  | "failed"
  | "empty";

export interface CompletionEvent {
  ts: string;
  model: string;
  effort: string;
  languageId: string;
  ttftMs: number;
  totalMs: number;
  completionLen: number;
  outcome: CompletionOutcome;
  declineReason?: string;
}

export interface MetricsSummary {
  windowHours: number;
  totalCompletions: number;
  accepted: number;
  partial: number;
  declined: number;
  cancelled: number;
  failed: number;
  empty: number;
  avgTtftMs: number;
  avgTotalMs: number;
  p50TtftMs: number;
  p95TtftMs: number;
  acceptRate: number;
}

export interface MetricsRecorder {
  record(event: CompletionEvent): void;
  summary(windowHours: number): Promise<MetricsSummary>;
  dispose(): void;
}

// Exported for tests; production stays at 10 MiB.
export const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;

interface CreateRecorderOptions {
  rotateBytes?: number;
}

export function createMetricsRecorder(
  isEnabled: () => boolean,
  logger: Logger,
  dir?: string,
  options?: CreateRecorderOptions,
): MetricsRecorder {
  const rootDir = dir ?? path.join(os.homedir(), ".claude-ghost");
  const filePath = path.join(rootDir, "metrics.jsonl");
  const rotatedPath = path.join(rootDir, "metrics.jsonl.1");
  const rotateBytes = options?.rotateBytes ?? DEFAULT_ROTATE_BYTES;

  let ensureDirPromise: Promise<void> | null = null;
  const ensureDir = async (): Promise<void> => {
    if (!ensureDirPromise) {
      ensureDirPromise = fs
        .mkdir(rootDir, { recursive: true })
        .then(() => undefined)
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === "EEXIST") return;
          throw err;
        });
    }
    await ensureDirPromise;
  };

  const maybeRotate = async (): Promise<void> => {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > rotateBytes) {
        await fs.rename(filePath, rotatedPath);
        logger.log(`metrics: rotated metrics.jsonl (${stat.size} bytes) -> metrics.jsonl.1`);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return;
      logger.log(`metrics: rotate check failed: ${e.message}`);
    }
  };

  const writeEvent = async (event: CompletionEvent): Promise<void> => {
    try {
      await ensureDir();
      const line = JSON.stringify(event) + "\n";
      await fs.appendFile(filePath, line, "utf8");
      await maybeRotate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log(`metrics: failed to record event: ${msg}`);
    }
  };

  const readFileLines = async (p: string): Promise<string[]> => {
    try {
      const text = await fs.readFile(p, "utf8");
      return text.split("\n");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return [];
      throw err;
    }
  };

  return {
    record(event: CompletionEvent): void {
      if (!isEnabled()) return;
      void writeEvent(event);
    },

    async summary(windowHours: number): Promise<MetricsSummary> {
      const cutoff = Date.now() - windowHours * 3600_000;
      const empty: MetricsSummary = {
        windowHours,
        totalCompletions: 0,
        accepted: 0,
        partial: 0,
        declined: 0,
        cancelled: 0,
        failed: 0,
        empty: 0,
        avgTtftMs: 0,
        avgTotalMs: 0,
        p50TtftMs: 0,
        p95TtftMs: 0,
        acceptRate: 0,
      };

      let lines: string[] = [];
      try {
        const current = await readFileLines(filePath);
        const rotated = await readFileLines(rotatedPath);
        lines = [...rotated, ...current];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log(`metrics: summary read failed: ${msg}`);
        return empty;
      }

      const events: CompletionEvent[] = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as CompletionEvent;
          if (typeof parsed.ts !== "string") continue;
          const tsMs = Date.parse(parsed.ts);
          if (Number.isNaN(tsMs)) continue;
          if (tsMs < cutoff) continue;
          events.push(parsed);
        } catch {
          // skip unparseable
        }
      }

      if (events.length === 0) return empty;

      const counts = { accepted: 0, partial: 0, declined: 0, cancelled: 0, failed: 0, empty: 0 };
      const ttfts: number[] = [];
      const totals: number[] = [];
      for (const e of events) {
        switch (e.outcome) {
          case "accepted":
            counts.accepted++;
            break;
          case "partial":
            counts.partial++;
            break;
          case "declined":
            counts.declined++;
            break;
          case "cancelled":
            counts.cancelled++;
            break;
          case "failed":
            counts.failed++;
            break;
          case "empty":
            counts.empty++;
            break;
        }
        if (typeof e.ttftMs === "number" && e.ttftMs >= 0) ttfts.push(e.ttftMs);
        if (typeof e.totalMs === "number" && e.totalMs >= 0) totals.push(e.totalMs);
      }

      ttfts.sort((a, b) => a - b);
      const pct = (arr: number[], p: number): number => {
        if (arr.length === 0) return 0;
        // Nearest-rank percentile.
        const rank = Math.min(arr.length - 1, Math.ceil((p / 100) * arr.length) - 1);
        return arr[Math.max(0, rank)];
      };
      const avg = (arr: number[]): number =>
        arr.length === 0 ? 0 : Math.round(arr.reduce((s, n) => s + n, 0) / arr.length);

      const total = events.length;
      const acceptRate =
        total === 0 ? 0 : (counts.accepted + counts.partial) / total;

      return {
        windowHours,
        totalCompletions: total,
        accepted: counts.accepted,
        partial: counts.partial,
        declined: counts.declined,
        cancelled: counts.cancelled,
        failed: counts.failed,
        empty: counts.empty,
        avgTtftMs: avg(ttfts),
        avgTotalMs: avg(totals),
        p50TtftMs: pct(ttfts, 50),
        p95TtftMs: pct(ttfts, 95),
        acceptRate,
      };
    },

    dispose(): void {
      // No-op: each append opens its own fd.
    },
  };
}
