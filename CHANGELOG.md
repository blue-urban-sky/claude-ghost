# Changelog

## [1.0.2] - 2026-04-23

### Fixed
- Mid-line completions now render. The provider previously set the accept-range from cursor to end-of-line unconditionally. That works for cursor-at-EOL but tells VS Code the ghost would delete everything to the right of the cursor — so VS Code silently refused to render for any mid-line trigger (e.g. typing inside a generic bound like `extends ▸>(fields: T)…`). The range is now sized to the exact character overlap between the completion's tail and the text right of the cursor (0 overlap → pure insertion, 1 char overlap for classic auto-closed `)` cases, full-tail overlap when the model re-emits the rest of the line). Behaviour on new-line / EOL triggers is unchanged.

### Added
- `completionOverlap(completion, after)` helper in `src/prompt.ts` with 8 unit tests covering the regression cases.
- Return-log now includes `overlapChars` and `afterNow.len` so the diagnostic output confirms the computed range at a glance.

## [1.0.1] - 2026-04-23

### Fixed
- Corrected `repository`, `bugs`, and `homepage` URLs in `package.json` to point at `blue-urban-sky/claude-ghost`.

### Added — diagnostic logging
Instrumentation pass to diagnose reports of ghost text silently stopping after a few minutes of use. Every branch of the completion pipeline is now traceable via the **Claude Ghost** output channel:
- Entry snapshot: document version, URI, active-editor match, `editor.inlineSuggest.enabled`, carried-over hint/maximalist/session-override state.
- Session resolution: logs `session resolved: id=… state=…` including overrides.
- Prior-inflight interrupts logged with the reason they fired / failed.
- Pre-return sanity check: warns if the document version changed mid-await, if the cursor moved out of bounds, if the line content drifted, or if the cleaned completion's prefix already exists after the cursor (the classic VS Code dedup suppression case).
- Explicit `returning 1 inline completion item (…, replacesChars=N)` line so the output confirms we actually reached the return.
- **Post-return watchdog**: 3 s after installing a pending completion, if no lifecycle event (accept / partial-accept / clear / cursor-move / doc-change) has touched it, logs a WARN pointing at the likely causes (inline-suggest disabled, competing providers, range mismatch). This is the direct signal for "logs look fine but nothing appears".
- Pending-cleared reasons now include offsets and a preview of the non-matching text, not just the generic label.
- Session state transitions logged (`primary state -> ready` etc.) so we can see exactly when the session flipped.
- Auto-trigger skips now say why (pending armed, session not ready, no active editor) instead of silently no-op-ing.

## [1.0.0] - 2026-04-22

First production-ready release. Full hardening pass across security, lifecycle, architecture, and release hygiene.

### Security
- Added `capabilities.untrustedWorkspaces` restricting spawn-affecting settings (`claudePath`, `model`, `bare`, `effort`, `disableThinking`, `maximalist`) in untrusted workspaces.
- `model` value validated and passed as `--model=<value>` to block argument injection.
- Per-request nonce boundary on file-tag envelope as prompt-injection defence; `«CURSOR»` / nonce collisions in file content are neutralised.
- `JsonlTailer` rejects symlinks and non-regular files; 8 MB buffer cap.

### Session lifecycle
- SIGKILL fallback after SIGTERM; hard 5 s timeout on `deactivate()`.
- `stop`/`restart` serialized via lifecycle mutex; `pending` cleared before restart; `exitResolvers` drained on fatal spawn errors.
- 10 s timeout on initialize handshake; 15 s GC on pending control requests.
- EPIPE on stdin routed via `child.stdin.on('error')` rather than sync try/catch.
- `cwd` plumbed through from the active workspace folder; stdout set to UTF-8.
- Auto-restart with exponential backoff (capped at 3 attempts / 60 s) on unexpected crash.

### Provider
- Cancellation checked before pending state is installed (no more spurious "edited elsewhere" declines).
- Drop-old / start-new inflight pattern via `AbortController` instead of FIFO queueing.
- Accepts `Automatic` trigger kind when `autoTrigger` is enabled.
- Public API narrowed — internal state is now hash-private with a typed surface.

### Architecture
- `extension.ts` split into focused modules: `state`, `log`, `paths`, `statusBar`, `sessionManager`, `sessionLogging`, `commands`.
- Three trigger variants unified behind a single `triggerCompletion({ hint?, maximalist?, session? })` helper.
- Multi-root workspace resolution via `getWorkspaceFolder(doc.uri)`.
- Provider selector covers `file`, `vscode-remote`, and `untitled` schemes.
- Error modals debounced (10 s collapse window).
- Discriminated-union `CliMessage` type with type guards replaces loose JSON parsing.

### TypeScript modernisation
- `unknown[]` over `any[]` in EventEmitter surfaces.
- Tagged-union queue items in `complete()` — no more `!` non-null assertions.
- Typed `onStateChange(state: SessionState)` end-to-end; no casts at wiring points.
- `SPAWN_AFFECTING_KEYS` typed as `ReadonlyArray<keyof typeof CFG>`.
- `node:` prefixes and named imports throughout.

### Release hygiene
- MIT `LICENSE`, `CHANGELOG.md` added.
- `Makefile`: `package` no longer auto-bumps patch; `release` target gates on clean tree + passing tests.
- `.vscodeignore` tightened — VSIX ships only `package.json`, `icon.png`, `README.md`, `LICENSE`, and `out/*.js` (16 files total).
- ESLint 9 flat config wired into `compile`; TypeScript 5.9, eslint 9.39, typescript-eslint 8.59.
- 35 unit tests across prompt, tailer, paths, and session type guards.
- `@vscode/vsce` pinned to 3.9.1 for reproducible packaging.
- Keybinding collision fixed: Windows / Linux now `Ctrl+Alt+\` (was colliding with `editor.action.jumpToBracket`).

## [0.0.26] - 2026-04-22

Last pre-hardening build. Functional inline ghost-text completions via local Claude CLI. All core features present (auto-trigger, maximalist mode, hint-based trigger, session restart). Known issue: VSIX bundle leaked development artifacts.
