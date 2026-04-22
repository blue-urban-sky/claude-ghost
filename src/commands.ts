import * as vscode from "vscode";
import type { ClaudeGhostProvider } from "./provider";
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
}

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: ClaudeGhostProvider,
  sessions: SessionManager,
  logging: SessionLogging,
  logger: Logger,
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
      const hint = await vscode.window.showInputBox({
        prompt: "Hint for the next completion",
        placeHolder: "e.g. use async/await, return early on null, make it recursive",
        ignoreFocusOut: true,
      });
      if (hint === undefined) return;
      await triggerCompletion({ hint });
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
