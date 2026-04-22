import * as vscode from "vscode";
import { JsonlTailer, formatJsonlLine } from "./tailer";
import { CFG, AUTO_TAIL_MAX_ATTEMPTS, TAIL_POLL_MS } from "./state";
import type { Logger } from "./log";
import type { ClaudeSession } from "./session";
import { sessionJsonlPath } from "./paths";

export interface SessionLogging {
  startTail(jsonlPath: string): void;
  stopTail(): void;
  scheduleAutoTail(getSession: () => ClaudeSession | null): void;
  currentPath(): string | null;
  buildBanner(jsonlPath: string, session: ClaudeSession | null): string;
  dispose(): void;
}

export function createSessionLogging(logger: Logger): SessionLogging {
  let tailer: JsonlTailer | null = null;
  let tailingPath: string | null = null;
  let autoTailTimer: NodeJS.Timeout | null = null;
  let autoTailAttempts = 0;

  const buildBanner = (jsonlPath: string, session: ClaudeSession | null): string => {
    const cfg = vscode.workspace.getConfiguration(CFG.section);
    const describe = <T,>(key: string, fallback: T, render: (v: T) => string = (v) => String(v)): string => {
      const inspect = cfg.inspect<T>(key);
      const value = cfg.get<T>(key, fallback);
      let source = "default";
      if (inspect?.workspaceFolderValue !== undefined) source = "folder";
      else if (inspect?.workspaceValue !== undefined) source = "workspace";
      else if (inspect?.globalValue !== undefined) source = "user";
      return `${render(value)}   [${source}]`;
    };

    const lines: string[] = [];
    lines.push("╭──────────────────────────────────────────────────╮");
    lines.push("│           Claude Ghost — session log            │");
    lines.push("╰──────────────────────────────────────────────────╯");
    if (session) {
      lines.push(`  session id     : ${session.sessionId}`);
      lines.push(`  state          : ${session.state}`);
    }
    lines.push(`  model          : ${describe<string>(CFG.model, "haiku")}`);
    lines.push(`  effort         : ${describe<string>(CFG.effort, "low")}`);
    lines.push(`  thinking       : ${describe<boolean>(CFG.disableThinking, true, (v) => v ? "disabled" : "enabled")}`);
    lines.push(`  bare           : ${describe<boolean>(CFG.bare, false)}`);
    lines.push(`  max chars      : ${describe<number>(CFG.maxChars, -1, (v) => v < 0 ? "uncapped" : String(v))}`);
    lines.push(`  context bytes  : ${describe<number>(CFG.contextMaxBytes, 100000)}`);
    lines.push(`  fallback lines : ±${cfg.get<number>(CFG.contextLines, 100)}`);
    const autoTriggerOn = cfg.get<boolean>(CFG.autoTrigger, false);
    if (autoTriggerOn) {
      lines.push(`  auto-trigger   : on, ${cfg.get<number>(CFG.autoTriggerDelayMs, 500)}ms idle`);
    } else {
      lines.push(`  auto-trigger   : off (manual keybinding only)`);
    }
    lines.push(`  jsonl          : ${jsonlPath}`);
    lines.push(`  claude path    : ${describe<string>(CFG.claudePath, "claude")}`);
    lines.push("");
    lines.push("  Setting scope shown in brackets. If a value isn't what you");
    lines.push("  set in User settings, check .vscode/settings.json in the");
    lines.push("  workspace — workspace/folder scopes override user.");
    lines.push("");
    lines.push("  Trigger with Cmd+Shift+\\  ·  Hint with Cmd+Shift+Alt+\\");
    lines.push("  Click status bar for session actions (restart, fork, copy id…)");
    lines.push("");
    return lines.join("\n");
  };

  const stopTail = (): void => {
    if (tailer) {
      tailer.stop();
      tailer = null;
    }
    tailingPath = null;
  };

  const startTail = (jsonlPath: string): void => {
    if (tailingPath === jsonlPath && tailer) {
      logger.sessionChannel.show(true);
      return;
    }
    stopTail();
    // Banner is emitted by callers that know the session context.
    logger.sessionChannel.show(true);
    const t = new JsonlTailer(
      jsonlPath,
      (line) => {
        const formatted = formatJsonlLine(line);
        if (formatted) logger.sessionChannel.appendLine(formatted);
      },
      true,
      (msg) => logger.log(msg),
    );
    const ok = t.start();
    if (!ok) {
      logger.sessionChannel.appendLine("[tailer failed to open file]");
      return;
    }
    tailer = t;
    tailingPath = jsonlPath;
  };

  const clearAutoTail = (): void => {
    if (autoTailTimer) {
      clearTimeout(autoTailTimer);
      autoTailTimer = null;
    }
    autoTailAttempts = 0;
  };

  const scheduleAutoTail = (getSession: () => ClaudeSession | null): void => {
    clearAutoTail();
    stopTail();
    const tryStart = (): void => {
      autoTailTimer = null;
      const session = getSession();
      if (!session) return;
      const p = sessionJsonlPath(session.sessionId);
      if (p) {
        logger.sessionChannel.appendLine(buildBanner(p, session));
        startTail(p);
        return;
      }
      autoTailAttempts++;
      if (autoTailAttempts >= AUTO_TAIL_MAX_ATTEMPTS) {
        logger.log(
          `auto-tail gave up after ${AUTO_TAIL_MAX_ATTEMPTS} attempts — JSONL never appeared`,
        );
        return;
      }
      autoTailTimer = setTimeout(tryStart, TAIL_POLL_MS);
    };
    tryStart();
  };

  return {
    startTail,
    stopTail,
    scheduleAutoTail,
    currentPath: () => tailingPath,
    buildBanner,
    dispose(): void {
      clearAutoTail();
      stopTail();
    },
  };
}
