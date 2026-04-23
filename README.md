# Claude Ghost

Inline ghost-text completions in VS Code, powered by your locally-authenticated `claude` CLI. No API key. No cloud proxy. One warm subprocess per window, driven over stdin/stdout.

## Requirements

- macOS or Linux
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/), authenticated (`claude auth login`)
- VS Code ≥ 1.90

## How it works

On activation the extension spawns a long-running `claude` process and holds the session open. Every trigger builds a fill-in-the-middle prompt from the editor, writes it to stdin, and streams the reply back as ghost text. Cancellation uses the CLI's `control_request.interrupt` — interrupting a generation ends the turn but keeps the session warm.

## Keys

| Action | macOS | Windows / Linux |
|---|---|---|
| Trigger completion | `Cmd+Shift+\` | `Ctrl+Alt+\` |
| Trigger with one-shot hint | `Cmd+Shift+Alt+\` | `Ctrl+Alt+Shift+\` |
| Accept | `Tab` | `Tab` |
| Accept next word | `Cmd+→` | `Ctrl+→` |
| Dismiss | `Esc` | `Esc` |

## Commands

All under `Claude Ghost:` in the command palette.

| Command | What it does |
|---|---|
| **Trigger Completion** | Same as the keybinding. With no selection, fills in ghost text at the cursor. With a selection, opens the Refactor Preview pane with the proposed rewrite. |
| **Refactor Selection** | Same as triggering with a selection — explicit entry point. Opens VS Code's native Refactor Preview (red/green diff, Apply / Discard). |
| **Trigger With Hint** | Input box; your instruction (e.g. `use async/await`) biases the next completion, then clears. |
| **Trigger Maximalist** *(experimental)* | Reads a nearby comment describing intent, generates a full in-file implementation. Needs `maximalist: true`. |
| **Restart Session** | Kills the current `claude` process and spawns a fresh session. |
| **Show Session Info** | Quick-pick with live-tail view, raw tail command, fork command, open-JSONL, copy-ID, restart. |
| **Insert Last Completion** | Force-inserts the last completion at the cursor (replaces the active selection if any) — escape hatch when ghost rendering is suppressed. |

## Settings

All under `claude-ghost.*`.

### Context

Beyond the current-file prompt, four context providers can augment the request with cross-file signal. Defaults keep bloat low: diff / symbols / hover are on (surgical, demand-driven); visible/recent is off (widest net).

| Setting | Default | Notes |
|---|---|---|
| `useSymbolResolution` | `true` | LSP `executeDefinitionProvider` on identifiers near the cursor; pulls the first ~40 lines of each defining file. |
| `symbolResolutionMaxFiles` | `6` | Cap on defining files per completion. |
| `useGitDiff` | `true` | Working-tree diff for the current file, stripped to hunk headers + ± lines, capped at 500 chars. Acts as an intent signal. |
| `useTypeInfo` | `true` | When the cursor sits right after `.` / `->` / `::`, pulls the receiver's type via LSP hover. |
| `extraContext` | `"off"` | `"off"` / `"recent"` / `"visible"` / `"visible+recent"`. Opt-in widest net — recent edits (ring buffer) and/or other open tabs (capped at 3). |
| `extraContextMaxBytes` | `30000` | Total byte budget across all the context providers above; excess is trimmed from the lowest-priority source. |

Per-call opt-in: prefix the `Trigger With Hint` input with `+visible` / `+recent` / `+symbols` / `+diff` to force a provider on for that one completion. Remaining text is the hint.

### Core

| Setting | Default | Notes |
|---|---|---|
| `model` | `haiku` | `haiku` / `sonnet` / `opus`, or a pinned full ID in JSON. |
| `effort` | `low` | `--effort` value. `low` keeps thinking budgets tight. |
| `disableThinking` | `true` | Sets `CLAUDE_CODE_DISABLE_THINKING=1`. Overrides global `alwaysThinkingEnabled`. **Leave this on** — turning thinking on adds ~15–25 s per completion on Haiku, which defeats the point of inline ghost text. |
| `bare` | `false` | Pass `--bare` to the CLI. Faster startup, but requires `ANTHROPIC_API_KEY` / `apiKeyHelper`. |
| `maxChars` | `-1` | Hard cap on completion length. `-1` = uncapped. |
| `autoTrigger` | `false` | Auto-request after an idle pause in typing. |
| `autoTriggerDelayMs` | `500` | Idle threshold for auto-trigger. |
| `maximalist` | `false` | Enable the maximalist command. |
| `maximalistFreshSession` | `true` | Restart the session before each maximalist run. |
| `contextMaxBytes` | `100000` | Files below this are sent whole. |
| `contextLines` | `100` | Window (±lines around cursor) when the file exceeds `contextMaxBytes`. |
| `claudePath` | `claude` | Path to the CLI binary. |

In untrusted workspaces the six spawn-affecting settings (`claudePath`, `model`, `bare`, `effort`, `disableThinking`, `maximalist`) are ignored per VS Code's workspace trust model.

## Observing a session

Every completion is persisted to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`. **Show Session Info** gives you the path and three ways to watch it:

- **Watch Session (Pretty)** — opens a *Claude Ghost Session* output channel with turns formatted inline:

  ```
  ── USER ──
  <file name="math.ts" language="typescript">
  export function add(a, b) {
    return «CURSOR»
  }
  </file>

  ── ASSISTANT ──
  a + b;
  ```

- **Copy Raw Tail Command** — `tail -f` the JSONL for raw output. Read-only, safe.
- **Copy Fork Command** — `claude --resume <uuid> --fork-session` opens an interactive chat that inherits history but writes to a fresh UUID. Poke at the session's context without touching it.

Plain `claude --resume <uuid>` (no `--fork-session`) would race the extension on the same JSONL — **always fork, or just tail**.

## Status bar

Bottom-left:

| State | Meaning |
|---|---|
| `$(sparkle) Claude Ghost` | Ready |
| `$(loading~spin) … starting` | Cold spawn (~2–5 s) |
| `$(loading~spin) Claude Ghost` | Generating |
| `$(error) … error` | See the *Claude Ghost* output channel |
| `$(debug-stop) … stopped` | Session is down |

Click to restart.

## Latency

Measured on macOS with Haiku 4.5, `disableThinking: true`:

- **Activation → ready**: 2–5 s
- **Warm TTFT**: 0.7–1.5 s
- **Full completion**: typically < 2 s

First completion after activation may be slower due to server-side model warm-up.

## Troubleshooting

- **Selecting code doesn't auto-trigger a completion** — by design. VS Code's inline-completion API only fires on manual trigger or on text edits (when `autoTrigger` is on). Cursor moves and clicks don't fire anything — same for Copilot, Cursor, and every other inline provider. After selecting, hit the trigger keybind: the selection is passed as a rewrite hint, and accepting replaces it in place.
- **Stuck on "starting"** — check the *Claude Ghost* output channel. Usually a missing binary (`claudePath`) or a failed CLI auth. Run `claude -p "hi"` in a terminal to verify the CLI on its own.
- **Empty ghost text** — the model returned content but VS Code suppressed it (common when the completion's opening character already exists at the cursor). Use *Insert Last Completion*.
- **Completions take 15 s+** — extended thinking is on. Set `disableThinking: true` (default). A global `alwaysThinkingEnabled: true` in `~/.claude/settings.json` is overridden by the extension's env var — no edit needed there.
- **Nonsense completion** — narrow the prompt with *Trigger With Hint*, or tune `contextLines` / `contextMaxBytes`.

## Privacy

No telemetry. No network calls from the extension itself — only `claude` talks to Anthropic's API. The session output channel and `~/.claude/projects/*.jsonl` contain the full source context you trigger on; treat them like any other log.

## Local metrics

Opt-in. Set `claude-ghost.localMetrics: true` to start recording a per-completion JSONL file at `~/.claude-ghost/metrics.jsonl`. Nothing is uploaded — the file is yours to `jq` against when tuning `model` / `effort`.

One line per completion with this shape:

```json
{ "ts": "...", "model": "...", "effort": "...", "languageId": "...", "ttftMs": 0, "totalMs": 0, "completionLen": 0, "outcome": "accepted|partial|declined|cancelled|failed|empty", "declineReason": "optional" }
```

Run **Claude Ghost: Show Metrics Summary** from the command palette for a windowed summary (1h / 6h / 24h / 7d): total completions, accept rate, avg/p95 TTFT.

The file rotates at 10 MB to `metrics.jsonl.1` (single backup; no further rotation).

## Building from source

```bash
make compile    # tsc
make test       # unit tests
make package    # build a .vsix (no version bump)
make release    # bump patch + package (requires clean tree)
make install    # package + install into local VS Code
make clean
```

Reload the window (`Developer: Reload Window`) after installing.

## License

MIT
