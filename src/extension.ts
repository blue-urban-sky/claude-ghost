import * as vscode from "vscode";
import { ClaudeGhostProvider } from "./provider";
import { createLogger } from "./log";
import { createStatusBar } from "./statusBar";
import { createSessionLogging } from "./sessionLogging";
import { createSessionManager } from "./sessionManager";
import { registerCommands } from "./commands";
import {
  CFG,
  SPAWN_AFFECTING_KEYS,
  AUTO_TRIGGER_DEBOUNCE_MS_DEFAULT,
  DEACTIVATE_HARD_TIMEOUT_MS,
} from "./state";

interface Disposables {
  dispose(): Promise<void> | void;
}

let disposeAll: Disposables | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push(logger.mainChannel, logger.sessionChannel);
  logger.log("extension activating");
  console.log("[claude-ghost] activating");

  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar.item);
  statusBar.update("idle");

  const logging = createSessionLogging(logger);

  const sessions = createSessionManager(logger, () => {
    logging.scheduleAutoTail(() => sessions.current());
  });
  sessions.onStateChange((s) => statusBar.update(s as Parameters<typeof statusBar.update>[0]));

  const provider = new ClaudeGhostProvider(() => sessions.current(), (msg) => logger.log(msg));

  // Multi-root + remote schemes: support files on local disk, remote
  // workspaces (SSH/WSL/codespaces), and untitled buffers.
  const documentSelector: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "vscode-remote" },
    { scheme: "untitled" },
  ];
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      documentSelector,
      provider,
    ),
  );

  registerCommands(context, provider, sessions, logging, logger);

  provider.onPendingCleared = (reason: string) => {
    logger.log(`declined (${reason})`);
    logger.sessionAppend(`\n── DECLINED (${reason}) ──`);
  };

  const declinePending = (reason: string) => {
    if (!provider.pending) return;
    provider.pending = null;
    logger.log(`declined (${reason})`);
    logger.sessionAppend(`\n── DECLINED (${reason}) ──`);
  };

  // Auto-trigger via a debounced timer is kept as a fallback for users on
  // older VS Code. Provider will also accept Automatic trigger kind now.
  let autoTriggerTimer: NodeJS.Timeout | null = null;
  const cancelAutoTrigger = (): void => {
    if (autoTriggerTimer) {
      clearTimeout(autoTriggerTimer);
      autoTriggerTimer = null;
    }
  };
  const scheduleAutoTrigger = (): void => {
    const cfg = vscode.workspace.getConfiguration(CFG.section);
    if (!cfg.get<boolean>(CFG.autoTrigger, false)) return;
    const delay = Math.max(
      50,
      cfg.get<number>(CFG.autoTriggerDelayMs, AUTO_TRIGGER_DEBOUNCE_MS_DEFAULT),
    );
    if (autoTriggerTimer) clearTimeout(autoTriggerTimer);
    autoTriggerTimer = setTimeout(() => {
      autoTriggerTimer = null;
      if (provider.pending) return;
      const session = sessions.current();
      if (!session || session.state !== "ready") return;
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      void vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }, delay);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) {
        const active = vscode.window.activeTextEditor;
        if (active && active.document === event.document) {
          scheduleAutoTrigger();
        }
      }
      const pending = provider.pending;
      if (!pending || event.document !== pending.document) return;
      if (event.contentChanges.length === 0) return;
      const change = event.contentChanges[0];
      const changeOffset = change.rangeOffset;
      if (changeOffset !== pending.offset) {
        declinePending("edited elsewhere");
        return;
      }
      if (change.text.length === 0) {
        declinePending("deleted at cursor");
        return;
      }
      if (!pending.remaining.startsWith(change.text)) {
        declinePending("typed non-matching text");
        return;
      }
      const accepted = change.text;
      const remaining = pending.remaining.slice(accepted.length);
      const kind = remaining.length === 0 ? "accepted" : "partially accepted";
      const preview = accepted.slice(0, 200).replace(/\n/g, "\\n");
      logger.log(`${kind} (${accepted.length} chars) preview=${JSON.stringify(preview)}`);
      logger.sessionAppend(
        `\n── ${kind === "accepted" ? "ACCEPTED" : "ACCEPTED (partial)"} ──\n${accepted}`,
      );
      if (remaining.length === 0) {
        provider.pending = null;
      } else {
        provider.pending = {
          document: pending.document,
          offset: pending.offset + accepted.length,
          remaining,
        };
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CFG.section)) return;
      const tailPath = logging.currentPath();
      if (tailPath) {
        logger.sessionAppend("");
        logger.sessionAppend("  (claude-ghost settings changed — banner refreshed below)");
        logger.sessionAppend(logging.buildBanner(tailPath, sessions.current()));
      }
      const needsRestart = SPAWN_AFFECTING_KEYS.some((k) =>
        event.affectsConfiguration(`${CFG.section}.${k}`),
      );
      if (needsRestart) sessions.scheduleRestartForSettings();
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      cancelAutoTrigger();
      const pending = provider.pending;
      if (!pending) return;
      if (!editor || editor.document !== pending.document) {
        declinePending("switched file");
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const pending = provider.pending;
      if (!pending) return;
      // Only react to selection changes in the pending document; ignore
      // peek views, diff editors, output panels, etc.
      if (event.textEditor.document !== pending.document) return;
      const offset = pending.document.offsetAt(event.selections[0].active);
      if (offset !== pending.offset) {
        declinePending("cursor moved");
      }
    }),
  );

  disposeAll = {
    async dispose(): Promise<void> {
      cancelAutoTrigger();
      logging.dispose();
      await sessions.dispose();
    },
  };

  // Fire-and-forget: status bar already reflects "starting". Awaiting here
  // keeps activate() blocked on a network-bound handshake, delaying the rest
  // of VS Code.
  void sessions.start();
}

export async function deactivate(): Promise<void> {
  if (!disposeAll) return;
  const handle = disposeAll;
  disposeAll = null;
  const hard = new Promise<void>((resolve) =>
    setTimeout(resolve, DEACTIVATE_HARD_TIMEOUT_MS),
  );
  await Promise.race([
    Promise.resolve(handle.dispose()).catch(() => undefined),
    hard,
  ]);
}
