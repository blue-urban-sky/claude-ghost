import * as vscode from "vscode";
import { ClaudeSession } from "./session";
import {
  buildPrompt,
  cleanCompletion,
  completionOverlap,
  findNearbyComment,
} from "./prompt";
import { assembleExtraContext } from "./context";
import { startProgressIndicator, type ProgressIndicator } from "./progressIndicator";
import { CFG } from "./state";

type Log = (msg: string) => void;

export interface PendingCompletion {
  document: vscode.TextDocument;
  offset: number;
  remaining: string;
}

export interface ProviderOverrides {
  visible?: boolean;
  recent?: boolean;
  symbols?: boolean;
  diff?: boolean;
}

export interface NextTriggerOpts {
  hint?: string;
  maximalist?: boolean;
  session?: ClaudeSession;
  providerOverrides?: ProviderOverrides;
  forceRegenerate?: boolean;
  // When the caller armed a selection-as-hint, this is the original selection
  // range. The provider uses it as the InlineCompletionItem's range so that
  // accepting the ghost REPLACES the whole selection instead of just inserting
  // at the caret.
  selectionRange?: vscode.Range;
}

export interface CompletionMeta {
  model: string;
  effort: string;
  languageId: string;
  ttftMs: number;
  totalMs: number;
  completionLen: number;
}

export type CompletionOutcomeSignal =
  | "cancelled"
  | "failed"
  | "empty";

export interface OutcomeEvent {
  outcome: CompletionOutcomeSignal;
  meta: CompletionMeta;
}

interface InflightEntry {
  abort: AbortController;
  promise: Promise<void>;
  promptHash: number;
  startedAt: number;
  getCollected: () => string;
}

// Cheap djb2 hash on length + first 128 chars + last 128 chars of the prompt.
// Used to dedup a double-trigger onto an in-flight request. This is not a
// security primitive — collisions are harmless (worst case we dedup when we
// shouldn't, and the user just re-triggers). Exported for tests.
export function promptHash(prompt: string): number {
  const len = prompt.length;
  const head = prompt.slice(0, 128);
  const tail = len > 128 ? prompt.slice(len - 128) : "";
  const material = `${len}:${head}:${tail}`;
  let h = 5381;
  for (let i = 0; i < material.length; i++) {
    h = ((h << 5) + h + material.charCodeAt(i)) | 0;
  }
  return h;
}

export class ClaudeGhostProvider implements vscode.InlineCompletionItemProvider {
  #inflight: InflightEntry | null = null;
  #lastCompletion: string | null = null;
  #nextHint: string | null = null;
  #nextMaximalist = false;
  #nextSession: ClaudeSession | null = null;
  #nextProviderOverrides: ProviderOverrides | null = null;
  #nextForceRegenerate = false;
  #nextSelectionRange: vscode.Range | null = null;
  #pending: PendingCompletion | null = null;
  // Monotonic counter used by the post-return watchdog to detect pendings
  // that were installed but never touched (accepted / cleared / moved). A
  // stale pending 3 s after return is a strong signal VS Code silently
  // dropped the ghost text render (common causes: doc changed mid-await,
  // overlap with text after cursor, inline-suggest disabled editor-wide).
  #pendingSerial = 0;
  #pendingInstalledAt = 0;
  readonly #getSession: () => ClaudeSession | null;
  readonly #log: Log;
  readonly #onPendingCleared: (reason: string) => void;
  readonly #onCompletionReturned: (meta: CompletionMeta) => void;
  readonly #onOutcome: (event: OutcomeEvent) => void;
  #lastReturnMeta: CompletionMeta | null = null;

  constructor(
    getSession: () => ClaudeSession | null,
    log: Log,
    onPendingCleared: (reason: string) => void = () => undefined,
    onCompletionReturned: (meta: CompletionMeta) => void = () => undefined,
    onOutcome: (event: OutcomeEvent) => void = () => undefined,
  ) {
    this.#getSession = getSession;
    this.#log = log;
    this.#onPendingCleared = onPendingCleared;
    this.#onCompletionReturned = onCompletionReturned;
    this.#onOutcome = onOutcome;
  }

  get lastCompletion(): string | null {
    return this.#lastCompletion;
  }

  get hasPending(): boolean {
    return this.#pending !== null;
  }

  get lastReturnMeta(): CompletionMeta | null {
    return this.#lastReturnMeta;
  }

  setNextTrigger(opts: NextTriggerOpts): void {
    if (opts.hint !== undefined) this.#nextHint = opts.hint;
    if (opts.maximalist) this.#nextMaximalist = true;
    if (opts.session) this.#nextSession = opts.session;
    if (opts.providerOverrides !== undefined) this.#nextProviderOverrides = opts.providerOverrides;
    if (opts.forceRegenerate) this.#nextForceRegenerate = true;
    if (opts.selectionRange) this.#nextSelectionRange = opts.selectionRange;
  }

  consumeNextProviderOverrides(): ProviderOverrides | null {
    const v = this.#nextProviderOverrides;
    this.#nextProviderOverrides = null;
    return v;
  }

  clearPending(reason: string): void {
    if (!this.#pending) return;
    const age = Date.now() - this.#pendingInstalledAt;
    this.#pendingSerial++;
    this.#pending = null;
    this.#log(`pending cleared (reason=${reason}, age=${age}ms)`);
    this.#onPendingCleared(reason);
  }

  // Consume a document-change event and update pending state. Returns the
  // accepted string (partial or full) so the caller can log, or null when the
  // event doesn't match the pending completion (either unrelated or declined).
  handleDocumentChange(
    event: vscode.TextDocumentChangeEvent,
  ): { accepted: string; full: boolean } | null {
    const pending = this.#pending;
    if (!pending || event.document !== pending.document) return null;
    if (event.contentChanges.length === 0) return null;
    const change = event.contentChanges[0];
    if (change.rangeOffset !== pending.offset) {
      this.clearPending(`edited elsewhere (change@${change.rangeOffset}, pending@${pending.offset})`);
      return null;
    }
    if (change.text.length === 0) {
      this.clearPending("deleted at cursor");
      return null;
    }
    if (!pending.remaining.startsWith(change.text)) {
      this.clearPending(
        `typed non-matching text (typed=${JSON.stringify(change.text.slice(0, 40))}, expected=${JSON.stringify(pending.remaining.slice(0, 40))})`,
      );
      return null;
    }
    const accepted = change.text;
    const remaining = pending.remaining.slice(accepted.length);
    if (remaining.length === 0) {
      this.#pendingSerial++;
      this.#pending = null;
      return { accepted, full: true };
    }
    this.#pending = {
      document: pending.document,
      offset: pending.offset + accepted.length,
      remaining,
    };
    return { accepted, full: false };
  }

  pendingMatchesDocument(document: vscode.TextDocument): boolean {
    return this.#pending !== null && this.#pending.document === document;
  }

  handleSelectionMovedTo(document: vscode.TextDocument, offset: number): void {
    const pending = this.#pending;
    if (!pending) return;
    if (document !== pending.document) return;
    if (offset !== pending.offset) {
      this.clearPending("cursor moved");
    }
  }

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
    const entryVersion = document.version;
    const entryUri = document.uri.toString();
    const activeEditor = vscode.window.activeTextEditor;
    const activeMatch = activeEditor?.document.uri.toString() === entryUri;
    const inlineEnabled = vscode.workspace
      .getConfiguration("editor")
      .get<boolean>("inlineSuggest.enabled", true);
    this.#log(
      `invoked (file=${document.fileName.split(/[\\/]/).pop()} line=${position.line} col=${position.character}, kind=${context.triggerKind}, version=${entryVersion}, activeMatch=${activeMatch}, inlineEnabled=${inlineEnabled}, selectedCompletion=${context.selectedCompletionInfo ? JSON.stringify(context.selectedCompletionInfo.text.slice(0, 40)) : "none"})`,
    );
    if (!inlineEnabled) {
      this.#log("WARN: editor.inlineSuggest.enabled is false — VS Code will not render any ghost text regardless of what we return");
    }
    if (this.#pending) {
      const age = Date.now() - this.#pendingInstalledAt;
      this.#log(
        `note: entering with an existing pending (age=${age}ms, remaining.len=${this.#pending.remaining.length}) — will be superseded`,
      );
    }
    const forceRegenerate = this.#nextForceRegenerate;
    this.#nextForceRegenerate = false;
    const selectionRange = this.#nextSelectionRange;
    this.#nextSelectionRange = null;
    if (this.#nextHint || this.#nextMaximalist || this.#nextSession || forceRegenerate || selectionRange) {
      this.#log(
        `carried-over trigger opts: hint=${this.#nextHint ? JSON.stringify(this.#nextHint.slice(0, 40)) : "-"}, maximalist=${this.#nextMaximalist}, sessionOverride=${this.#nextSession ? "yes" : "no"}, forceRegenerate=${forceRegenerate}, selectionRange=${selectionRange ? `[${selectionRange.start.line}:${selectionRange.start.character}..${selectionRange.end.line}:${selectionRange.end.character}]` : "-"}`,
      );
    }
    const currentLine = document.lineAt(position.line);
    const before = currentLine.text.slice(0, position.character);
    const after = currentLine.text.slice(position.character);
    this.#log(
      `line ctx: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    );
    const overrideSession = this.#nextSession;
    this.#nextSession = null;
    const session = overrideSession ?? this.#getSession();
    this.#log(
      `session resolved: ${session ? `id=${session.sessionId} state=${session.state}${overrideSession ? " (override)" : ""}` : "null"}`,
    );
    if (!session) {
      this.#log("no session — aborting");
      return undefined;
    }

    // Build the prompt up front so we can hash it for in-flight dedup before
    // deciding whether to abort any prior inflight.
    const hint = this.#nextHint;
    this.#nextHint = null;
    const useMaximalist = this.#nextMaximalist;
    this.#nextMaximalist = false;
    let maximalist: { task: string } | undefined;
    if (useMaximalist) {
      const task = findNearbyComment(document, position);
      if (!task) {
        this.#log("maximalist requested but no nearby comment found — falling back to regular completion");
        void vscode.window.showWarningMessage("Claude Ghost: maximalist mode needs a nearby comment describing what to build.");
      } else {
        maximalist = { task };
        this.#log(`maximalist task: ${JSON.stringify(task)}`);
      }
    }
    const overrides = this.consumeNextProviderOverrides();
    const extraContext = await assembleExtraContext(
      document,
      position,
      cfg,
      overrides,
      this.#log,
    );
    const prompt = buildPrompt(document, position, {
      contextMaxBytes: cfg.get<number>(CFG.contextMaxBytes, 100000),
      contextLines: cfg.get<number>(CFG.contextLines, 100),
      hint: hint ?? undefined,
      maximalist,
      extraContext,
      languageId: document.languageId,
    });
    const maxChars = cfg.get<number>(CFG.maxChars, -1);
    this.#log(`prompt built (${prompt.length} chars${maximalist ? ", maximalist" : ""}${hint ? `, hint=${JSON.stringify(hint)}` : ""}, lang=${document.languageId})`);
    if (extraContext.length > 0) {
      const totalChars = extraContext.reduce((n, c) => n + c.text.length, 0);
      const bySource = extraContext.reduce<Record<string, number>>((acc, c) => {
        acc[c.source] = (acc[c.source] ?? 0) + 1;
        return acc;
      }, {});
      const breakdown = Object.entries(bySource)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      this.#log(`extra context: ${extraContext.length} chunks (${totalChars} chars, ${breakdown})`);
    }
    const newPromptHash = promptHash(prompt);

    // Debounced in-flight dedup: identical prompts fired within 300 ms share
    // the in-flight result instead of aborting and restarting. Force-regenerate
    // (item 9a) always bypasses dedup.
    if (this.#inflight && !forceRegenerate) {
      const age = Date.now() - this.#inflight.startedAt;
      if (this.#inflight.promptHash === newPromptHash && age < 300) {
        this.#log(`trigger deduped to in-flight (age=${age}ms)`);
        const dedupInflight = this.#inflight;
        try {
          await dedupInflight.promise;
        } catch {
          // ignored — the original caller owns reporting
        }
        if (token.isCancellationRequested) {
          this.#log("dedup: token cancelled after awaiting in-flight");
          return undefined;
        }
        const collected = dedupInflight.getCollected();
        const cleaned = cleanCompletion(collected);
        if (!cleaned.trim()) {
          this.#log(`dedup: in-flight produced empty result (raw=${collected.length} chars)`);
          return undefined;
        }
        const dedupStartedAt = dedupInflight.startedAt;
        const dedupMetaBuilder = (completionLen: number): CompletionMeta => ({
          model: cfg.get<string>(CFG.model, "haiku"),
          effort: cfg.get<string>(CFG.effort, "low"),
          languageId: document.languageId,
          ttftMs: -1,
          totalMs: Date.now() - dedupStartedAt,
          completionLen,
        });
        return this.#installPending(document, position, cleaned, before, after, entryVersion, dedupMetaBuilder, selectionRange);
      }
    }

    // Drop-old/start-new: cancel any prior inflight immediately rather than
    // waiting FIFO-style. The old call's for-await handles cancellation.
    if (this.#inflight) {
      this.#log(forceRegenerate ? "force-regenerate: aborting prior inflight" : "aborting prior inflight");
      this.#inflight.abort.abort();
      if (session.state === "generating") {
        try {
          await session.interrupt();
          this.#log("prior inflight interrupted");
        } catch (err) {
          this.#log(`prior-inflight interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Don't await the prior promise here — let it unwind on its own.
    }

    if (token.isCancellationRequested) {
      this.#log("cancelled before start");
      return undefined;
    }

    if (session.state === "generating") {
      this.#log("session busy — interrupting");
      try {
        await session.interrupt();
        this.#log(`interrupt returned, state now=${session.state}`);
      } catch (err) {
        this.#log(`interrupt threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (session.state !== "ready") {
      this.#log(`session not ready (state=${session.state}) — try again after status bar shows ready`);
      return undefined;
    }

    this.clearPending("superseded");

    let collected = "";
    let cancelled = false;
    let failed: Error | undefined;
    const startedAt = Date.now();
    let firstDeltaAt: number | null = null;
    let deltaCount = 0;

    const abort = new AbortController();
    // Tie VS Code cancellation into our AbortSignal so all cleanup
    // (heartbeat, progress indicator, inflight tracking) listens to a single
    // source of truth.
    const tokenSub = token.onCancellationRequested(() => abort.abort());

    // Optional in-editor progress indicator: braille spinner decoration at
    // the end of the cursor line, cycles while the model is generating. Kept
    // off by default would be tempting, but the whole UX complaint is "I
    // can't tell if it's working" — so default is on. Setting lets users
    // silence it.
    let progress: ProgressIndicator | null = null;
    const showProgress = cfg.get<boolean>(CFG.showProgressIndicator, true);
    const progressEditor = vscode.window.activeTextEditor;
    if (
      showProgress &&
      progressEditor &&
      progressEditor.document.uri.toString() === document.uri.toString()
    ) {
      try {
        progress = startProgressIndicator(progressEditor, position.line);
      } catch {
        // Decoration creation can fail on disposed editors; non-fatal.
        progress = null;
      }
    }

    // Heartbeat runs until the finally-block clears it; the inner guard just
    // skips logging once we've aborted so we don't spam the channel.
    const heartbeat = setInterval(() => {
      if (abort.signal.aborted) return;
      const elapsed = Date.now() - startedAt;
      this.#log(
        `still waiting (elapsed=${elapsed}ms, deltas=${deltaCount}, chars=${collected.length}, firstDelta=${firstDeltaAt ? firstDeltaAt - startedAt : "-"})`,
      );
    }, 5000);

    const work = (async () => {
      this.#log("sending prompt to session");
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
            this.#log(`first delta (ttft=${firstDeltaAt - startedAt}ms)`);
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
            this.#log(`maxChars hit (${collected.length} >= ${maxChars}) — interrupting`);
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
      }
    })();

    this.#inflight = {
      abort,
      promise: work,
      promptHash: newPromptHash,
      startedAt,
      getCollected: () => collected,
    };
    try {
      await work;
    } finally {
      clearInterval(heartbeat);
      if (progress) progress.stop();
      if (this.#inflight && this.#inflight.promise === work) {
        this.#inflight = null;
      }
      tokenSub.dispose();
    }

    const totalMs = Date.now() - startedAt;
    const ttftMs = firstDeltaAt ? firstDeltaAt - startedAt : -1;
    const model = cfg.get<string>(CFG.model, "haiku");
    const effort = cfg.get<string>(CFG.effort, "low");
    const languageId = document.languageId;
    const buildMeta = (completionLen: number): CompletionMeta => ({
      model,
      effort,
      languageId,
      ttftMs,
      totalMs,
      completionLen,
    });

    if (failed) {
      this.#log(`completion failed after ${totalMs}ms: ${failed.message}`);
      this.#onOutcome({ outcome: "failed", meta: buildMeta(collected.length) });
      return undefined;
    }
    if (cancelled) {
      this.#log(`cancelled after ${totalMs}ms (collected=${collected.length})`);
      this.#onOutcome({ outcome: "cancelled", meta: buildMeta(collected.length) });
      return undefined;
    }

    const cleaned = cleanCompletion(collected);
    if (!cleaned.trim()) {
      this.#log(
        `empty completion (raw=${collected.length} chars, ttft=${ttftMs}ms, total=${totalMs}ms)`,
      );
      this.#onOutcome({ outcome: "empty", meta: buildMeta(0) });
      return undefined;
    }

    const tokenCancelled = token.isCancellationRequested;
    // Check cancellation BEFORE installing pending state, otherwise a cancelled
    // completion still arms `pending` and the next keystroke triggers a
    // spurious "edited elsewhere" decline.
    if (tokenCancelled) {
      this.#log(
        `completion discarded — token cancelled (raw=${collected.length} chars)`,
      );
      this.#onOutcome({ outcome: "cancelled", meta: buildMeta(cleaned.length) });
      return undefined;
    }

    const preview = cleaned.slice(0, 200).replace(/\n/g, "\\n");
    this.#log(
      `completion (${cleaned.length} chars, ttft=${ttftMs}ms, total=${totalMs}ms) preview=${JSON.stringify(preview)}`,
    );

    return this.#installPending(document, position, cleaned, before, after, entryVersion, buildMeta, selectionRange);
  }

  #installPending(
    document: vscode.TextDocument,
    position: vscode.Position,
    cleaned: string,
    before: string,
    after: string,
    entryVersion: number,
    metaBuilder: (completionLen: number) => CompletionMeta,
    selectionRange: vscode.Range | null,
  ): vscode.InlineCompletionItem[] {
    // Pre-return sanity: if the document changed or the position drifted while
    // we were awaiting the model, VS Code will silently refuse to render the
    // item — the range we compute references stale coordinates. Log aggressively
    // so the exact cause is visible in the output channel.
    const nowVersion = document.version;
    const versionChanged = nowVersion !== entryVersion;
    const lineAtReturn = position.line < document.lineCount
      ? document.lineAt(position.line)
      : null;
    const positionInBounds =
      lineAtReturn !== null && position.character <= lineAtReturn.text.length;
    const afterNow = lineAtReturn
      ? lineAtReturn.text.slice(position.character)
      : "";
    const beforeNow = lineAtReturn
      ? lineAtReturn.text.slice(0, position.character)
      : "";
    const contextDrifted = beforeNow !== before || afterNow !== after;
    if (versionChanged) {
      this.#log(
        `WARN: document version changed during completion (entry=${entryVersion}, now=${nowVersion}) — VS Code may refuse to render`,
      );
    }
    if (!positionInBounds) {
      this.#log(
        `WARN: cursor position is now out of bounds (line=${position.line}/${document.lineCount}, col=${position.character}, lineLen=${lineAtReturn?.text.length ?? "n/a"}) — VS Code will refuse to render`,
      );
    }
    if (contextDrifted) {
      this.#log(
        `WARN: line content around cursor drifted — beforeAtEntry=${JSON.stringify(before)} beforeAtReturn=${JSON.stringify(beforeNow)} afterAtEntry=${JSON.stringify(after)} afterAtReturn=${JSON.stringify(afterNow)}`,
      );
    }
    this.#lastCompletion = cleaned;
    // Range sizing falls into two modes:
    //   1. Selection-as-hint: the user had text selected at trigger time. The
    //      caller collapsed the editor's selection (so Tab doesn't indent) and
    //      passed the original range here. We use that as the replacement
    //      range so accepting REPLACES the selection wholesale.
    //   2. Normal cursor trigger: size the replacement to exactly cover the
    //      overlap (if any) between the tail of `cleaned` and the head of
    //      `afterNow`. With 0 overlap the range is empty (pure insertion),
    //      which is what mid-line completions need to render at all.
    let range: vscode.Range;
    let overlap = 0;
    let pendingOffset: number;
    if (selectionRange) {
      range = selectionRange;
      pendingOffset = document.offsetAt(selectionRange.start);
    } else {
      overlap = completionOverlap(cleaned, afterNow);
      const rangeEndOffset = document.offsetAt(position) + overlap;
      const rangeEnd = document.positionAt(rangeEndOffset);
      range = new vscode.Range(position, rangeEnd);
      pendingOffset = document.offsetAt(position);
    }
    this.#pending = {
      document,
      offset: pendingOffset,
      remaining: cleaned,
    };
    this.#pendingInstalledAt = Date.now();
    const mySerial = ++this.#pendingSerial;

    this.#log(
      `returning 1 inline completion item (cleaned.length=${cleaned.length}, range=[${range.start.line}:${range.start.character}..${range.end.line}:${range.end.character}], mode=${selectionRange ? "selection-replace" : "overlap"}, overlapChars=${overlap}, afterNow.len=${afterNow.length})`,
    );

    const returnMeta = metaBuilder(cleaned.length);
    this.#lastReturnMeta = returnMeta;
    this.#onCompletionReturned(returnMeta);

    // Post-return watchdog: if nothing touches this pending within 3 s (no
    // accept, no clear, no cursor move, no doc change), the ghost almost
    // certainly wasn't rendered. Fires once; no-op if the pending was
    // superseded, accepted, or explicitly cleared.
    setTimeout(() => {
      if (this.#pendingSerial !== mySerial) return;
      if (this.#pending === null) return;
      this.#log(
        `WARN: 3 s after return, pending is still installed with no lifecycle event — ghost text likely not rendered by VS Code (file=${document.fileName.split(/[\\/]/).pop()}, len=${cleaned.length}). Check: editor.inlineSuggest.enabled, competing inline-completion providers, or a range mismatch.`,
      );
    }, 3000);

    return [new vscode.InlineCompletionItem(cleaned, range)];
  }
}
