import * as vscode from "vscode";
import type { SessionState } from "./session";

interface StatusBarEntry {
  text: string;
  bg?: string;
}

// `satisfies` gives us exhaustiveness over SessionState without widening
// the return type.
const LABELS: Record<SessionState, StatusBarEntry> = {
  idle: { text: "$(circle-outline) Claude Ghost" },
  starting: { text: "$(loading~spin) Claude Ghost: starting" },
  ready: { text: "$(sparkle) Claude Ghost" },
  generating: { text: "$(loading~spin) Claude Ghost" },
  error: {
    text: "$(error) Claude Ghost: error",
    bg: "statusBarItem.errorBackground",
  },
  stopped: { text: "$(debug-stop) Claude Ghost: stopped" },
} satisfies Record<SessionState, StatusBarEntry>;

export interface StatusBar {
  update(state: SessionState): void;
  item: vscode.StatusBarItem;
}

export function createStatusBar(): StatusBar {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.tooltip = "Claude Ghost — click for session info";
  item.command = "claude-ghost.showSession";
  item.show();

  return {
    item,
    update(state: SessionState): void {
      const entry = LABELS[state];
      item.text = entry.text;
      item.backgroundColor = entry.bg
        ? new vscode.ThemeColor(entry.bg)
        : undefined;
    },
  };
}
