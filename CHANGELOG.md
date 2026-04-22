# Changelog

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
