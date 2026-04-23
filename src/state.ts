import type { SessionState } from "./session";

// Centralised config keys so a typo fails at compile time.
export const CFG = {
  section: "claude-ghost",
  model: "model",
  claudePath: "claudePath",
  bare: "bare",
  effort: "effort",
  disableThinking: "disableThinking",
  systemPrompt: "systemPrompt",
  maxChars: "maxChars",
  contextLines: "contextLines",
  contextMaxBytes: "contextMaxBytes",
  autoTrigger: "autoTrigger",
  autoTriggerDelayMs: "autoTriggerDelayMs",
  maximalist: "maximalist",
  maximalistFreshSession: "maximalistFreshSession",
  localMetrics: "localMetrics",
  extraContext: "extraContext",
  extraContextMaxBytes: "extraContextMaxBytes",
  useSymbolResolution: "useSymbolResolution",
  symbolResolutionMaxFiles: "symbolResolutionMaxFiles",
  useGitDiff: "useGitDiff",
  useTypeInfo: "useTypeInfo",
} as const;

// Settings keys that require respawning the child CLI. Changing these
// triggers a debounced session restart.
export const SPAWN_AFFECTING_KEYS: ReadonlyArray<keyof typeof CFG> = [
  "model",
  "effort",
  "disableThinking",
  "bare",
  "claudePath",
];

export const AUTO_TRIGGER_DEBOUNCE_MS_DEFAULT = 500;
export const SETTINGS_RESTART_DEBOUNCE_MS = 500;
export const TAIL_POLL_MS = 1_000;
export const AUTO_TAIL_MAX_ATTEMPTS = 30;
export const DEACTIVATE_HARD_TIMEOUT_MS = 5_000;
export const ERROR_MESSAGE_COLLAPSE_WINDOW_MS = 10_000;
export const AUTO_RESTART_MAX_ATTEMPTS = 3;
export const AUTO_RESTART_WINDOW_MS = 60_000;

export type { SessionState };
