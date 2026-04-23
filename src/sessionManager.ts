import * as vscode from "vscode";
import {
  ClaudeSession,
  isStreamEvent,
  isTextDelta,
  type CliMessage,
  type EffortLevel,
  type SessionState,
} from "./session";
import { SYSTEM_PROMPT, MAXIMALIST_SYSTEM_PROMPT } from "./prompt";
import {
  CFG,
  SETTINGS_RESTART_DEBOUNCE_MS,
  AUTO_RESTART_MAX_ATTEMPTS,
  AUTO_RESTART_WINDOW_MS,
} from "./state";
import type { Logger } from "./log";
import { errorMessage } from "./log";
import { preferredWorkspaceFolderFsPath } from "./paths";

export interface SessionManager {
  current(): ClaudeSession | null;
  maximalist(): ClaudeSession | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  ensureMaximalist(fresh: boolean): Promise<ClaudeSession>;
  scheduleRestartForSettings(): void;
  dispose(): Promise<void>;
  onStateChange(cb: (state: SessionState) => void): vscode.Disposable;
}

export function createSessionManager(
  logger: Logger,
  onReady: (session: ClaudeSession) => void,
): SessionManager {
  let session: ClaudeSession | null = null;
  let maximalistSession: ClaudeSession | null = null;
  let settingsRestartTimer: NodeJS.Timeout | null = null;
  let restartMutex: Promise<void> | null = null;
  const stateListeners = new Set<(state: SessionState) => void>();
  // Track unexpected-crash restarts within a sliding window.
  let recentRestartAttempts: number[] = [];

  const emitState = (s: SessionState): void => {
    for (const l of stateListeners) {
      try {
        l(s);
      } catch {
        // ignore
      }
    }
  };

  const wireSession = (s: ClaudeSession, label: string): void => {
    s.on("state", (state) => {
      logger.log(`${label} state -> ${state}`);
      if (label === "primary") emitState(state);
    });
    s.on("error", (err) => {
      logger.log(`${label} session error: ${err.message}`);
      if (label === "primary") {
        logger.showError(err.message);
        scheduleAutoRestartIfCrashed(s);
      }
    });
    s.on("stderr", (chunk: string) => {
      logger.log(`${label} stderr: ${chunk.trim()}`);
    });
    if (label === "primary") {
      s.on("stdout-line", (msg: CliMessage) => {
        const type = msg.type;
        let subtype = "";
        let extra = "";
        if (isStreamEvent(msg)) {
          const evt = msg.event;
          const deltaType = isTextDelta(evt) ? evt.delta.type : null;
          extra = ` ${evt.type}${deltaType ? `:${deltaType}` : ""}`;
        } else if (msg.type === "result") {
          subtype = msg.subtype ? `/${msg.subtype}` : "";
          extra = ` is_error=${String(msg.is_error)}`;
        } else if ("subtype" in msg && typeof msg.subtype === "string") {
          subtype = `/${msg.subtype}`;
        }
        logger.log(`<< ${type}${subtype}${extra}`);
      });
    }
  };

  const buildPrimary = (): ClaudeSession => {
    const cfg = vscode.workspace.getConfiguration(CFG.section);
    const cwd = preferredWorkspaceFolderFsPath() ?? undefined;
    const s = new ClaudeSession({
      model: cfg.get<string>(CFG.model, "claude-haiku-4-5-20251001"),
      claudePath: cfg.get<string>(CFG.claudePath, "claude"),
      bare: cfg.get<boolean>(CFG.bare, false),
      effort: cfg.get<EffortLevel>(CFG.effort, "low"),
      disableThinking: cfg.get<boolean>(CFG.disableThinking, true),
      systemPrompt: SYSTEM_PROMPT,
      cwd,
    });
    wireSession(s, "primary");
    return s;
  };

  const buildMaximalist = (): ClaudeSession => {
    const cfg = vscode.workspace.getConfiguration(CFG.section);
    const cwd = preferredWorkspaceFolderFsPath() ?? undefined;
    const s = new ClaudeSession({
      model: cfg.get<string>(CFG.model, "haiku"),
      claudePath: cfg.get<string>(CFG.claudePath, "claude"),
      bare: cfg.get<boolean>(CFG.bare, false),
      effort: cfg.get<EffortLevel>(CFG.effort, "low"),
      disableThinking: cfg.get<boolean>(CFG.disableThinking, true),
      systemPrompt: MAXIMALIST_SYSTEM_PROMPT,
      cwd,
    });
    wireSession(s, "maximalist");
    return s;
  };

  const start = async (): Promise<void> => {
    session = buildPrimary();
    try {
      await session.start();
      logger.log(`session ready (id=${session.sessionId})`);
      onReady(session);
    } catch (err) {
      logger.showError(`failed to start: ${errorMessage(err)}`);
    }
  };

  const stop = async (): Promise<void> => {
    if (session) {
      try {
        await session.stop();
      } catch {
        // ignore
      }
      session = null;
    }
    if (maximalistSession) {
      try {
        await maximalistSession.stop();
      } catch {
        // ignore
      }
      maximalistSession = null;
    }
  };

  const restart = async (): Promise<void> => {
    if (restartMutex) {
      await restartMutex;
      return;
    }
    restartMutex = (async () => {
      if (!session) {
        await start();
        return;
      }
      try {
        await session.restart();
        onReady(session);
      } catch (err) {
        logger.log(`restart failed: ${errorMessage(err)}`);
        logger.showError(`restart failed: ${errorMessage(err)}`);
      }
      if (maximalistSession) {
        try {
          await maximalistSession.stop();
        } catch {
          // ignore
        }
        maximalistSession = null;
      }
    })().finally(() => {
      restartMutex = null;
    });
    return restartMutex;
  };

  const ensureMaximalist = async (fresh: boolean): Promise<ClaudeSession> => {
    if (maximalistSession && fresh) {
      logger.log("maximalist: restarting maximalist session for clean context");
      logger.sessionAppend("\n  (maximalist mode — restarting maximalist session…)");
      await maximalistSession.restart();
      return maximalistSession;
    }
    if (maximalistSession) return maximalistSession;
    logger.log("maximalist: creating maximalist session");
    logger.sessionAppend("\n  (maximalist mode — spawning dedicated session…)");
    const ms = buildMaximalist();
    await ms.start();
    maximalistSession = ms;
    return ms;
  };

  const scheduleRestartForSettings = (): void => {
    if (settingsRestartTimer) clearTimeout(settingsRestartTimer);
    settingsRestartTimer = setTimeout(async () => {
      settingsRestartTimer = null;
      if (!session) return;
      logger.log("spawn-affecting setting changed — restarting session");
      logger.sessionAppend("\n  (restarting session to apply new settings…)");
      await restart();
    }, SETTINGS_RESTART_DEBOUNCE_MS);
  };

  const scheduleAutoRestartIfCrashed = (crashed: ClaudeSession): void => {
    if (crashed !== session) return;
    const now = Date.now();
    recentRestartAttempts = recentRestartAttempts.filter(
      (t) => now - t < AUTO_RESTART_WINDOW_MS,
    );
    if (recentRestartAttempts.length >= AUTO_RESTART_MAX_ATTEMPTS) {
      logger.log(
        `auto-restart suppressed — ${recentRestartAttempts.length} attempts in last ${AUTO_RESTART_WINDOW_MS}ms`,
      );
      return;
    }
    recentRestartAttempts.push(now);
    const delayMs = 500 * Math.pow(2, recentRestartAttempts.length - 1);
    logger.log(
      `scheduling auto-restart in ${delayMs}ms (attempt ${recentRestartAttempts.length}/${AUTO_RESTART_MAX_ATTEMPTS})`,
    );
    setTimeout(() => {
      if (crashed !== session) return;
      void restart();
    }, delayMs);
  };

  return {
    current: () => session,
    maximalist: () => maximalistSession,
    start,
    stop,
    restart,
    ensureMaximalist,
    scheduleRestartForSettings,
    dispose: stop,
    onStateChange(cb): vscode.Disposable {
      stateListeners.add(cb);
      return new vscode.Disposable(() => stateListeners.delete(cb));
    },
  };
}
