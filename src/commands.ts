import * as vscode from "vscode";
import type { ClaudeGhostProvider, ProviderOverrides } from "./provider";
import type { SessionManager } from "./sessionManager";
import type { SessionLogging } from "./sessionLogging";
import type { Logger } from "./log";
import type { ClaudeSession } from "./session";
import { CFG } from "./state";
import { errorMessage } from "./log";
import { sessionJsonlPath, shellQuote } from "./paths";

export interface TriggerOpts {
  hint?: string;
  maximalist?: boolean;
  session?: ClaudeSession;
  providerOverrides?: ProviderOverrides;
  forceRegenerate?: boolean;
}

const SELECTION_HINT_MAX = 2000;

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
): void {
  const triggerCompletion = async (
    opts: TriggerOpts = {},
    source: "plain" | "hint" | "maximalist" = "plain",
  ): Promise<void> => {
    // Selection-as-hint: only the plain trigger, only when no explicit hint
    // was provided. Keeps the hint keybind and the maximalist command
    // untouched, and respects a user-supplied hint verbatim.
    if (source === "plain" && opts.hint === undefined) {
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.selection;
      if (editor && selection && !selection.isEmpty) {
        const raw = editor.document.getText(selection);
        const truncated = raw.length > SELECTION_HINT_MAX
          ? raw.slice(0, SELECTION_HINT_MAX) + " …(truncated)"
          : raw;
        opts = { ...opts, hint: `complete or rewrite: ${truncated}` };
        logger.log(`selection-as-hint (${raw.length} chars)`);
      }
    }
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
        await triggerCompletion({ maximalist: true, session: ms }, "maximalist");
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
        await triggerCompletion(
          {
            hint: parsed.hint.length > 0 ? parsed.hint : undefined,
            providerOverrides: parsed.overrides,
          },
          "hint",
        );
        return;
      }
      // No tokens — preserve the pre-existing UX: empty hint is still passed.
      await triggerCompletion({ hint: raw }, "hint");
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
        edit.insert(editor.selection.active, last);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-ghost.trigger", async () => {
      // Regenerate path: if a ghost is already visible, re-roll with a
      // "different approach" hint instead of firing selection-as-hint. Skips
      // in-flight dedup via forceRegenerate.
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
}
