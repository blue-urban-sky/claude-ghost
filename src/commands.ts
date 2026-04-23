import * as vscode from "vscode";
import type { ClaudeGhostProvider, ProviderOverrides } from "./provider";
import type { SessionManager } from "./sessionManager";
import type { SessionLogging } from "./sessionLogging";
import type { Logger } from "./log";
import type { ClaudeSession } from "./session";
import type { MetricsRecorder, MetricsSummary } from "./metrics";
import { CFG } from "./state";
import { errorMessage } from "./log";
import { sessionJsonlPath, shellQuote } from "./paths";
import { buildRefactorPrompt, cleanCompletion } from "./prompt";

export interface TriggerOpts {
  hint?: string;
  maximalist?: boolean;
  session?: ClaudeSession;
  providerOverrides?: ProviderOverrides;
  forceRegenerate?: boolean;
}

export interface HintParseResult {
  hint: string;
  overrides: ProviderOverrides;
  anyTokens: boolean;
}

// Parse leading `+visible|+recent|+symbols|+diff` tokens from the hint input.
// Unknown `+tokens` are NOT recognised — they pass through as hint content
// (mirroring the common "typo is a hint, don't silently drop it" rule).
// Exported for testing.
export function parseHintInput(raw: string): HintParseResult {
  const known = new Set(["visible", "recent", "symbols", "diff"]);
  const overrides: ProviderOverrides = {};
  let rest = raw;
  let anyTokens = false;
  while (true) {
    const m = /^\s*\+([A-Za-z]+)(\s+|$)/.exec(rest);
    if (!m) break;
    const name = m[1].toLowerCase();
    if (!known.has(name)) break;
    anyTokens = true;
    switch (name) {
      case "visible": overrides.visible = true; break;
      case "recent": overrides.recent = true; break;
      case "symbols": overrides.symbols = true; break;
      case "diff": overrides.diff = true; break;
    }
    rest = rest.slice(m[0].length);
  }
  return { hint: rest.trim(), overrides, anyTokens };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: ClaudeGhostProvider,
  sessions: SessionManager,
  logging: SessionLogging,
  logger: Logger,
  metrics?: MetricsRecorder,
): void {
  const triggerCompletion = async (opts: TriggerOpts = {}): Promise<void> => {
    provider.setNextTrigger(opts);
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.triggerMaximalist", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG.section);
      if (!cfg.get<boolean>(CFG.maximalist, false)) {
        const choice = await vscode.window.showWarningMessage(
          "Claude Ghost: maximalist mode is disabled. Enable it in settings?",
          "Open Settings",
        );
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "claude-ghost.maximalist");
        }
        return;
      }
      try {
        const ms = await sessions.ensureMaximalist(
          cfg.get<boolean>(CFG.maximalistFreshSession, true),
        );
        await triggerCompletion({ maximalist: true, session: ms });
      } catch (err) {
        logger.log(`maximalist session failed: ${errorMessage(err)}`);
        logger.showError(`maximalist session failed — ${errorMessage(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.triggerWithHint", async () => {
      const raw = await vscode.window.showInputBox({
        prompt: "Hint for the next completion (prefix with +visible / +recent / +symbols / +diff to opt-in Wave-2 providers for this call)",
        placeHolder: "e.g. use async/await, return early on null, make it recursive",
        ignoreFocusOut: true,
      });
      if (raw === undefined) return;
      const parsed = parseHintInput(raw);
      if (parsed.anyTokens) {
        const enabled: string[] = [];
        if (parsed.overrides.visible) enabled.push("visible");
        if (parsed.overrides.recent) enabled.push("recent");
        if (parsed.overrides.symbols) enabled.push("symbols");
        if (parsed.overrides.diff) enabled.push("diff");
        const hintForLog = parsed.hint.length > 0 ? parsed.hint : null;
        logger.log(`hint overrides (providers=[${enabled.join(",")}], hint=${hintForLog !== null ? JSON.stringify(hintForLog) : "\"-\""})`);
        await triggerCompletion({
          hint: parsed.hint.length > 0 ? parsed.hint : undefined,
          providerOverrides: parsed.overrides,
        });
        return;
      }
      // No tokens — preserve the pre-existing UX: empty hint is still passed.
      await triggerCompletion({ hint: raw });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.insertLast", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const last = provider.lastCompletion;
      if (!last) {
        vscode.window.showInformationMessage("Claude Ghost: no completion cached yet");
        return;
      }
      await editor.edit((edit) => {
        // If there's an active selection, replace it — matches the
        // selection-as-hint semantic (the user selected what they wanted
        // rewritten). Otherwise insert at cursor.
        if (!editor.selection.isEmpty) {
          edit.replace(editor.selection, last);
        } else {
          edit.insert(editor.selection.active, last);
        }
      });
    }),
  );

  const runRefactorSelection = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage("Claude Ghost: select some code first.");
      return;
    }
    const session = sessions.current();
    if (!session || session.state !== "ready") {
      vscode.window.showWarningMessage(
        `Claude Ghost: session not ready (state=${session?.state ?? "null"}). Try again in a moment.`,
      );
      return;
    }
    const document = editor.document;
    const selection = new vscode.Range(editor.selection.start, editor.selection.end);
    const entryVersion = document.version;
    const cfg = vscode.workspace.getConfiguration(CFG.section);
    const prompt = buildRefactorPrompt(document, selection, {
      contextMaxBytes: cfg.get<number>(CFG.contextMaxBytes, 100000),
      contextLines: cfg.get<number>(CFG.contextLines, 100),
      languageId: document.languageId,
    });
    logger.log(
      `refactor-selection prompt built (${prompt.length} chars, range=[${selection.start.line}:${selection.start.character}..${selection.end.line}:${selection.end.character}], lang=${document.languageId})`,
    );

    try {
      const replacement = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Claude Ghost: refactoring selection…",
          cancellable: true,
        },
        async (_progress, token): Promise<string | null> => {
          const startedAt = Date.now();
          let collected = "";
          const cancelSub = token.onCancellationRequested(async () => {
            try {
              await session.interrupt();
            } catch {
              // ignore
            }
          });
          try {
            for await (const delta of session.complete(prompt)) {
              if (token.isCancellationRequested) break;
              collected += delta;
            }
          } finally {
            cancelSub.dispose();
          }
          if (token.isCancellationRequested) {
            logger.log(`refactor-selection cancelled (collected=${collected.length})`);
            return null;
          }
          const cleaned = cleanCompletion(collected);
          logger.log(
            `refactor-selection completed (${cleaned.length} chars, total=${Date.now() - startedAt}ms)`,
          );
          return cleaned.trim() ? cleaned : null;
        },
      );

      if (!replacement) {
        vscode.window.showInformationMessage("Claude Ghost: no refactor produced.");
        return;
      }
      if (document.version !== entryVersion) {
        vscode.window.showWarningMessage(
          "Claude Ghost: document changed during refactor — aborted to avoid applying to stale coordinates.",
        );
        logger.log(`refactor-selection aborted: document version ${entryVersion} → ${document.version}`);
        return;
      }

      // Open the native Refactor Preview pane with red/green diff and
      // Apply/Discard buttons. `isRefactoring: true` tells VS Code this is a
      // code transformation, not a simple insert — surfaces the preview UI
      // and the undo grouping with a descriptive label.
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, selection, replacement, {
        label: "Claude Ghost: rewrite selection",
        needsConfirmation: true,
        iconPath: new vscode.ThemeIcon("sparkle"),
      });
      const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
      logger.log(`refactor-selection applyEdit returned ${applied}`);
    } catch (err) {
      logger.log(`refactor-selection failed: ${errorMessage(err)}`);
      logger.showError(`refactor failed — ${errorMessage(err)}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.refactorSelection", runRefactorSelection),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.trigger", async () => {
      // Regenerate path: if a ghost is already visible, re-roll with a
      // "different approach" hint. Skips in-flight dedup via forceRegenerate.
      if (provider.hasPending) {
        const prevLen = provider.lastCompletion?.length ?? "n/a";
        logger.log(`regenerate (previous.len=${prevLen})`);
        provider.setNextTrigger({
          hint: "generate a different approach than the previous suggestion",
          forceRegenerate: true,
        });
        await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        return;
      }
      // Selection-dispatch: non-empty selection routes to the refactor-preview
      // flow (native diff panel with Apply/Discard). Empty selection stays on
      // the inline-ghost path. Same keybind, one muscle-memory.
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        await runRefactorSelection();
        return;
      }
      await triggerCompletion();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.restart", async () => {
      logger.log("restart requested");
      try {
        await sessions.restart();
      } catch (err) {
        logger.showError(`restart failed: ${errorMessage(err)}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.showSession", async () => {
      const session = sessions.current();
      if (!session) {
        vscode.window.showInformationMessage("Claude Ghost: no session");
        return;
      }
      const id = session.sessionId;
      const jsonlPath = sessionJsonlPath(id);
      const tailCmd = jsonlPath ? `tail -f ${shellQuote(jsonlPath)}` : null;
      const forkCmd = `claude --resume ${id} --fork-session`;
      const pathNote = jsonlPath ? jsonlPath : "(JSONL not yet written — send one completion first)";

      const items: vscode.QuickPickItem[] = [
        { label: "$(output) Watch Session (Pretty)", description: "live-tail in an Output channel, formatted", detail: pathNote },
        { label: "$(eye) Copy Raw Tail Command", description: "tail -f … (read-only terminal command)", detail: tailCmd ?? pathNote },
        { label: "$(git-branch) Copy Fork Command", description: "claude --resume <id> --fork-session", detail: forkCmd },
        { label: "$(go-to-file) Open JSONL", description: "raw session log in a new tab", detail: pathNote },
        { label: "$(clippy) Copy Session ID", description: id },
        { label: "$(refresh) Restart Session", description: "stop the current session and spawn a fresh one" },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `Claude Ghost — session ${id} (${session.state})`,
        placeHolder: "Choose an action",
      });
      if (!picked) return;

      if (picked.label.endsWith("Watch Session (Pretty)")) {
        if (!jsonlPath) {
          vscode.window.showWarningMessage("No JSONL on disk yet. Trigger a completion first.");
        } else {
          logger.sessionChannel.appendLine(logging.buildBanner(jsonlPath, session));
          logging.startTail(jsonlPath);
        }
      } else if (picked.label.endsWith("Copy Session ID")) {
        await vscode.env.clipboard.writeText(id);
        vscode.window.showInformationMessage("Session ID copied.");
      } else if (picked.label.endsWith("Copy Raw Tail Command")) {
        if (!tailCmd) {
          vscode.window.showWarningMessage("No JSONL on disk yet. Trigger a completion first.");
        } else {
          await vscode.env.clipboard.writeText(tailCmd);
          vscode.window.showInformationMessage("Tail command copied.");
        }
      } else if (picked.label.endsWith("Copy Fork Command")) {
        await vscode.env.clipboard.writeText(forkCmd);
        vscode.window.showInformationMessage("Fork command copied.");
      } else if (picked.label.endsWith("Open JSONL")) {
        if (!jsonlPath) {
          vscode.window.showWarningMessage("No JSONL on disk yet. Trigger a completion first.");
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(jsonlPath);
          await vscode.window.showTextDocument(doc);
        } catch (err) {
          logger.showError(`could not open JSONL at ${jsonlPath}: ${errorMessage(err)}`);
        }
      } else if (picked.label.endsWith("Restart Session")) {
        await vscode.commands.executeCommand("claude-ghost.restart");
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.showMetricsSummary", async () => {
      const cfg = vscode.workspace.getConfiguration(CFG.section);
      if (!cfg.get<boolean>(CFG.localMetrics, false)) {
        const choice = await vscode.window.showInformationMessage(
          "Local metrics are disabled. Enable `claude-ghost.localMetrics` in settings to start recording.",
          "Open Settings",
        );
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "claude-ghost.localMetrics",
          );
        }
        return;
      }
      if (!metrics) {
        vscode.window.showInformationMessage("Claude Ghost: metrics recorder unavailable.");
        return;
      }
      interface WindowPick extends vscode.QuickPickItem {
        hours: number;
      }
      const windows: WindowPick[] = [
        { label: "1h", hours: 1 },
        { label: "6h", hours: 6 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 24 * 7 },
      ];
      const picked = await vscode.window.showQuickPick(windows, {
        title: "Claude Ghost — Metrics Window",
        placeHolder: "Pick a reporting window",
      });
      if (!picked) return;
      try {
        const summary = await metrics.summary(picked.hours);
        vscode.window.showInformationMessage(formatMetricsSummary(picked.label, summary));
      } catch (err) {
        logger.showError(`metrics summary failed: ${errorMessage(err)}`);
      }
    }),
  );
}

function formatMetricsSummary(label: string, s: MetricsSummary): string {
  if (s.totalCompletions === 0) {
    return `${label}: no completions recorded in window.`;
  }
  const pct = Math.round(s.acceptRate * 100);
  const fmtMs = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
  return `${label}: ${s.totalCompletions} completions, ${pct}% accepted (avg ttft ${fmtMs(s.avgTtftMs)}, p95 ${fmtMs(s.p95TtftMs)})`;
}
