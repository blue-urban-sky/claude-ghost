import * as vscode from "vscode";
import { ClaudeSession } from "./session";
import { buildPrompt, cleanCompletion, findNearbyComment } from "./prompt";
import { CFG } from "./state";

type Log = (msg: string) => void;

export interface PendingCompletion {
  document: vscode.TextDocument;
  offset: number;
  remaining: string;
}

interface InflightEntry {
  abort: AbortController;
  promise: Promise<void>;
}

export class ClaudeGhostProvider implements vscode.InlineCompletionItemProvider {
  private inflight: InflightEntry | null = null;
  public lastCompletion: string | null = null;
  public nextHint: string | null = null;
  public nextMaximalist: boolean = false;
  public nextSession: ClaudeSession | null = null;
  public pending: PendingCompletion | null = null;
  public onPendingCleared: ((reason: string) => void) | null = null;

  constructor(
    private readonly getSession: () => ClaudeSession | null,
    private readonly log: Log,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = vscode.workspace.getConfiguration(CFG.section);
    const autoTriggerOn = cfg.get<boolean>(CFG.autoTrigger, false);
    // Accept Automatic only when the user opted in; otherwise require explicit
    // invocation (keybinding). This lets VS Code drive auto-completion natively
    // when enabled, instead of our bespoke timer.
    if (
      context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke &&
      !autoTriggerOn
    ) {
      return undefined;
    }
    this.log(
      `invoked (file=${document.fileName.split(/[\\/]/).pop()} line=${position.line} col=${position.character}, kind=${context.triggerKind})`,
    );
    const currentLine = document.lineAt(position.line);
    const before = currentLine.text.slice(0, position.character);
    const after = currentLine.text.slice(position.character);
    this.log(
      `line ctx: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
    const overrideSession = this.nextSession;
    this.nextSession = null;
    const session = overrideSession ?? this.getSession();
    if (!session) {
      this.log("no session");
      return undefined;
    }

    // Drop-old/start-new: cancel any prior inflight immediately rather than
    // waiting FIFO-style. The old call's for-await handles cancellation.
    if (this.inflight) {
      this.log("aborting prior inflight");
      this.inflight.abort.abort();
      if (session.state === "generating") {
        try {
          await session.interrupt();
        } catch {
          // ignore
        }
      }
      // Don't await the prior promise here — let it unwind on its own.
    }

    if (token.isCancellationRequested) {
      this.log("cancelled before start");
      return undefined;
    }

    if (session.state === "generating") {
      this.log("session busy — interrupting");
      try {
        await session.interrupt();
      } catch {
        // ignore
      }
    }
    if (session.state !== "ready") {
      this.log(`session not ready (state=${session.state}) — try again after status bar shows ready`);
      return undefined;
    }

    if (this.pending) {
      this.pending = null;
      if (this.onPendingCleared) this.onPendingCleared("superseded");
    }

    const hint = this.nextHint;
    this.nextHint = null;
    const useMaximalist = this.nextMaximalist;
    this.nextMaximalist = false;
    let maximalist: { task: string } | undefined;
    if (useMaximalist) {
      const task = findNearbyComment(document, position);
      if (!task) {
        this.log("maximalist requested but no nearby comment found — falling back to regular completion");
        void vscode.window.showWarningMessage("Claude Ghost: maximalist mode needs a nearby comment describing what to build.");
      } else {
        maximalist = { task };
        this.log(`maximalist task: ${JSON.stringify(task)}`);
      }
    }
    const prompt = buildPrompt(document, position, {
      contextMaxBytes: cfg.get<number>(CFG.contextMaxBytes, 100000),
      contextLines: cfg.get<number>(CFG.contextLines, 100),
      hint: hint ?? undefined,
      maximalist,
    });
    const maxChars = cfg.get<number>(CFG.maxChars, -1);
    this.log(`prompt built (${prompt.length} chars${maximalist ? ", maximalist" : ""}${hint ? `, hint=${JSON.stringify(hint)}` : ""})`);

    let collected = "";
    let cancelled = false;
    let failed: Error | null = null;
    const startedAt = Date.now();
    let firstDeltaAt: number | null = null;
    let deltaCount = 0;

    const abort = new AbortController();
    // Tie VS Code cancellation into our AbortSignal so all cleanup
    // (heartbeat, inflight tracking) listens to a single source of truth.
    const tokenSub = token.onCancellationRequested(() => abort.abort());

    // Heartbeat tied to AbortSignal — no setInterval + finally-cleared pattern.
    let heartbeat: NodeJS.Timeout | null = setInterval(() => {
      if (abort.signal.aborted) return;
      const elapsed = Date.now() - startedAt;
      this.log(
        `still waiting (elapsed=${elapsed}ms, deltas=${deltaCount}, chars=${collected.length}, firstDelta=${firstDeltaAt ? firstDeltaAt - startedAt : "-"})`,
      );
    }, 5000);
    abort.signal.addEventListener("abort", () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    });

    const work = (async () => {
      this.log("sending prompt to session");
      let iter: AsyncIterable<string>;
      try {
        iter = session.complete(prompt);
      } catch (err) {
        failed = err instanceof Error ? err : new Error(String(err));
        return;
      }
      try {
        for await (const delta of iter) {
          if (firstDeltaAt === null) {
            firstDeltaAt = Date.now();
            this.log(`first delta (ttft=${firstDeltaAt - startedAt}ms)`);
          }
          deltaCount++;
          if (abort.signal.aborted) {
            cancelled = true;
            try {
              await session.interrupt();
            } catch {
              // ignore
            }
            break;
          }
          collected += delta;
          if (maxChars >= 0 && collected.length >= maxChars) {
            this.log(`maxChars hit (${collected.length} >= ${maxChars}) — interrupting`);
            try {
              await session.interrupt();
            } catch {
              // ignore
            }
            break;
          }
        }
      } catch (err) {
        failed = err instanceof Error ? err : new Error(String(err));
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      }
    })();

    this.inflight = { abort, promise: work };
    try {
      await work;
    } finally {
      if (this.inflight && this.inflight.promise === work) {
        this.inflight = null;
      }
      tokenSub.dispose();
    }

    const totalMs = Date.now() - startedAt;
    const ttftMs = firstDeltaAt ? firstDeltaAt - startedAt : -1;

    if (failed) {
      this.log(`completion failed after ${totalMs}ms: ${(failed as Error).message}`);
      return undefined;
    }
    if (cancelled) {
      this.log(`cancelled after ${totalMs}ms (collected=${collected.length})`);
      return undefined;
    }

    const cleaned = cleanCompletion(collected);
    if (!cleaned.trim()) {
      this.log(
        `empty completion (raw=${collected.length} chars, ttft=${ttftMs}ms, total=${totalMs}ms)`,
      );
      return undefined;
    }

    const tokenCancelled = token.isCancellationRequested;
    // Check cancellation BEFORE installing pending state, otherwise a cancelled
    // completion still arms `pending` and the next keystroke triggers a
    // spurious "edited elsewhere" decline.
    if (tokenCancelled) {
      this.log(
        `completion discarded — token cancelled (raw=${collected.length} chars)`,
      );
      return undefined;
    }

    const preview = cleaned.slice(0, 200).replace(/\n/g, "\\n");
    this.log(
      `completion (${cleaned.length} chars, ttft=${ttftMs}ms, total=${totalMs}ms) preview=${JSON.stringify(preview)}`,
    );
    this.lastCompletion = cleaned;
    this.pending = {
      document,
      offset: document.offsetAt(position),
      remaining: cleaned,
    };
    // Replace through end of current line so the ghost text doesn't collide
    // with characters already after the cursor (VS Code suppresses rendering
    // when the suggestion prefix matches existing text).
    const range = new vscode.Range(position, currentLine.range.end);
    return [new vscode.InlineCompletionItem(cleaned, range)];
  }
}
