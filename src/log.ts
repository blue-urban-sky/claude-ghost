import * as vscode from "vscode";
import { ERROR_MESSAGE_COLLAPSE_WINDOW_MS } from "./state";

export interface Logger {
  log(msg: string): void;
  sessionAppend(msg: string): void;
  showError(msg: string): void;
  mainChannel: vscode.OutputChannel;
  sessionChannel: vscode.OutputChannel;
  dispose(): void;
}

export function createLogger(): Logger {
  const main = vscode.window.createOutputChannel("Claude Ghost");
  const session = vscode.window.createOutputChannel("Claude Ghost Session");
  const recentErrors = new Map<string, { last: number; count: number }>();

  const log = (msg: string): void => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    main.appendLine(line);
    console.log(`[claude-ghost] ${line}`);
  };

  return {
    mainChannel: main,
    sessionChannel: session,
    log,
    sessionAppend(msg: string): void {
      session.appendLine(msg);
    },
    showError(msg: string): void {
      const now = Date.now();
      const prior = recentErrors.get(msg);
      if (prior && now - prior.last < ERROR_MESSAGE_COLLAPSE_WINDOW_MS) {
        prior.count++;
        prior.last = now;
        log(`suppressed duplicate error (${prior.count}x): ${msg}`);
        return;
      }
      recentErrors.set(msg, { last: now, count: 1 });
      void vscode.window.showErrorMessage(`Claude Ghost: ${msg}`);
    },
    dispose(): void {
      main.dispose();
      session.dispose();
    },
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
