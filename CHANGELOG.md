# Changelog

## [Unreleased]

### Changed
- Production-readiness pass: security hardening, untrusted workspace capabilities, keybinding collision fixes
- Extension lifecycle refactor (extension.ts): cleaner activation/deactivation, improved session management
- Release process overhauled — Makefile no longer auto-bumps patch on every `make package`; use `make release` for intentional version bumps
- `.vscodeignore` tightened to prevent `.idea/`, `generated_imgs/`, Makefile, and other dev artifacts leaking into the VSIX bundle
- Added `capabilities.untrustedWorkspaces` to `package.json` restricting spawn-affecting settings in untrusted workspaces
- Added `license`, `repository`, `bugs`, `homepage`, and `keywords` fields to `package.json`
- Tests added for core completion and session lifecycle logic

## [0.0.26] - 2026-04-22

Last pre-hardening build. Functional inline ghost-text completions via local Claude CLI. All core features present (auto-trigger, maximalist mode, hint-based trigger, session restart). Known issue: VSIX bundle leaked development artifacts.
