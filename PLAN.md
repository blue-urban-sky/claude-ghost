Here is Claude's plan:                                                                                                                                                                                                                                                                                                                                                                                                                                                            

Claude Ghost — Roadmap & Future Enhancements

Context

Claude Ghost is single-purpose by design: warm claude subprocess, fill-in-the-middle prompt, stream to ghost text. Current prompt sees only the current file (whole file under 100 KB, otherwise ±100 lines around cursor). Claude's 200 k context is therefore ~90 % empty on every call, which caps suggestion quality for anything that touches multiple files or relies on type information.

This document tracks planned enhancements in three tiers. Each item is independently shippable. Tier ordering is by ROI — do Tier 1 in order, then stop and reassess.

Blocker — RESOLVED in v1.0.2. Root cause was not the VS Code render path; it was a range-calculation bug in the provider. Before v1.0.2, the accept-range was set from cursor to end-of-line unconditionally. Fine for EOL triggers (empty range = pure insertion) but broken for mid-line triggers — VS Code silently refused to render any ghost that would obliterate unrelated text further along the line. Fixed by sizing the range to the exact overlap between the completion's tail and the head of after-cursor text. See CHANGELOG.md [1.0.2] and src/prompt.ts::completionOverlap.

 ---
Tier 1 — high ROI, fits the single-purpose remit

1. Visible-editors + recent-edits context

Pull the first ~300 lines of each tab currently open and the last N files edited in this session. Two or three extra files almost always lift cross-file suggestion quality dramatically. Cost: one ContextBuilder module, ~60 lines, ~zero latency (we're already warm).

- Add src/context.ts exposing buildExtraContext(document, budgetChars): ContextChunk[] where ContextChunk = { source, label, text }
- Source 1 — vscode.window.visibleTextEditors, skip the active editor, take first 300 lines of each
- Source 2 — recent-edits ring buffer (e.g. last 5 documents), populated from the existing onDidChangeTextDocument handler in src/extension.ts
- Budget split: each source gets extraContextMaxBytes / 3; trim by head-lines to preserve imports/types at top
- New setting claude-ghost.extraContext: "off" | "visible" | "visible+recent" (default "visible")
- New setting claude-ghost.extraContextMaxBytes (default 30 000)
- src/prompt.ts buildPrompt() accepts extraContext: ContextChunk[] — emit each chunk as <file name="…" language="…" role="context">…</file> BEFORE the cursor file, so the cursor file stays the final, highest-attention chunk
- Reuse the existing per-request nonce boundary — escape <file> / «CURSOR» leakage in extra chunks identically
- src/provider.ts calls buildExtraContext and threads through
- Log line: extra context: N chunks (M chars, sources=[visible,recent]) at build time
- Add tests in src/test/context.test.ts — budget respected, priority order, "off" returns []
- Extend prompt.test.ts — chunks render correctly, nonce escaping holds for extra files

2. Selection-as-hint

If the user has a non-empty selection when they trigger, treat it as an implicit "complete this / rewrite this" task. Zero new UI; massive ergonomic win.

- In src/commands.ts, triggerCompletion reads vscode.window.activeTextEditor?.selection
- If non-empty, pass { hint: "complete or rewrite: <selection>" } to provider.setNextTrigger
- Truncate selection to ~2 000 chars to cap hint budget
- Only applies to the plain trigger command — triggerWithHint keeps its explicit-input UX, triggerMaximalist has its own comment-based task source
- Log line: selection-as-hint (N chars) when it fires
- Manual smoke test: select a function signature line, trigger, confirm completion fills it coherently

3. Language-aware system prompt + stop sequences

Current SYSTEM_PROMPT is one-size-fits-all. A dispatch on document.languageId with small nudges (e.g. "Python: no semicolons, preserve import order", "Rust: don't reintroduce use lines already present") cuts low-grade formatting mistakes. Stop sequences (fence close, blank-line after block) trim wasted tokens and lower TTFT.

- Export languageStyleFor(languageId: string): string from src/prompt.ts
- Starter language set, informed by a survey of the user's primary monorepo (inshur-platform): python (9.7k files), java (5.1k), typescript + typescriptreact (3.8k), go (1.9k), javascript + javascriptreact (0.6k), shellscript (0.3k), terraform (0.3k), kotlin (0.2k). Fallback returns empty. Rust dropped from the set — zero usage in the target workspace.
- Per-language nudge content — keep each under ~200 chars
- Java/Kotlin note: these are Spring-Boot heavy in the target repo; nudges should reflect that (e.g. "Kotlin: prefer val, avoid !!, use safe calls ?.", "Java: honour package-info.java if present, don't reintroduce wildcard imports")
- Decision: system prompt is fixed at session-spawn (warm session), so emit the language nudge as a compact <style> tag inside each prompt rather than spawning per-language sessions
- buildPrompt accepts languageId, embeds the nudge after extra context and before the cursor file
- src/provider.ts passes document.languageId through
- Investigate whether claude CLI supports pass-through stop sequences via stream-json input; if yes, wire per-language stops (fence close, blank-line-after-block)
- Tests — languageStyleFor returns base for unknown ids; nudges present for each starter language

4. LSP-sourced type info

One vscode.executeHoverProvider call on the identifier under cursor gives Claude the exact type signature. Tiny budget cost, large accuracy win for typed languages.

- Helper getHoverAtCursor(document, position): string | null — calls vscode.commands.executeCommand<Hover[]>('vscode.executeHoverProvider', …), pulls the first markdown string, strips fences
- Fail-open: if no hover provider is registered or the call throws, return null
- Cap extracted hover at ~500 chars
- Embed in prompt as <type-info>…</type-info> block near the cursor
- Only fire when document.languageId is in the typed-languages set (TS/JS, Python with Pyright, Go, Rust, Java, C#, Swift)
- Log line: hover-type-info (len=N, source=<languageId>) when present
- Setting claude-ghost.useTypeInfo: boolean (default true)

 ---
Tier 2 — worth doing after Tier 1 proves out

5. Symbol resolution via LSP

For the 5–10 identifiers in the ±10 lines around cursor, call executeDefinitionProvider, attach the first 40 lines of each defining file. Stronger than "recent files" because it's demand-driven, not guess-based. Cost: latency spike on first call, then cache.

- Tokenise ±10 lines around cursor; dedupe to unique identifiers
- For each, call vscode.executeDefinitionProvider
- Cache resolved definitions by (uri, line, word) → Location[] (LRU, ~50 entries)
- For each definition URI, pull first 40 lines, dedupe against already-included extra-context chunks
- Add to ContextBuilder as ImportsProvider (or similar)
- Benchmark: ensure additional latency under 300 ms on first call

6. Unstaged git diff of the current file

git diff HEAD -- <file> as a preamble: "here's what's currently being changed". Signals intent that raw context can't.

- Detect git repository using vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1)
- Pull the diff via the git extension API, not raw subprocess (handles non-standard repo layouts)
- Embed as <pending-diff>…</pending-diff> block before the current file
- Cap diff at ~3 000 chars; if larger, skip with a log note
- Setting claude-ghost.useGitDiff: boolean (default true)

7. Budget-aware context assembly

Explicit ContextBuilder abstraction with pluggable providers (CurrentFile, VisibleEditors, RecentEdits, Hover, Imports, GitDiff) and a total character budget sliced by priority. Enables experimentation without rewrites each time.

- Define ContextProvider interface: { id: string; priority: number; build(document, position, budget): Promise<ContextChunk[]> }
- Refactor Tier 1 / Tier 2 sources into providers
- Total budget from contextMaxBytes; each provider is offered budget * (priority / sum) with rebate on unused
- Log line: context assembled: {currentFile=Nk, visible=Nk, recent=Nk, hover=Nk, imports=Nk, diff=Nk} total=Nk/Mk
- Setting claude-ghost.contextProviders: string[] to enable/disable individual providers

8. Workspace-guideline auto-ingestion

Many repos already document their conventions — the target monorepo (inshur-platform) has docs/guidelines/{kotlin,java,typescript,nodejs,golang,spring,react,infrastructure}.md, plus a CLAUDE.md at the app root. Auto-ingesting the relevant file for the current language turns existing engineering documentation into free, per-project language nudges. No manual maintenance, consistently aligned with what engineers are already trained on.

- Lookup order per completion: (1) <workspaceRoot>/CLAUDE.md, (2) <workspaceRoot>/docs/guidelines/<languageId-alias>.md, (3) nearest CLAUDE.md walking up from the current file
- Aliases: typescript → typescript.md, kotlin → kotlin.md, java → java.md, etc. Pluralise where repos use plural naming
- Cap each injected snippet at ~1 500 chars (head of the file); strip Markdown frontmatter
- Cache per-workspace on load; invalidate on document change within the guidelines directory
- Embed as <project-guidelines source="…">…</project-guidelines> block, placed BEFORE the language nudge so the project's rules take precedence over generic ones
- Setting claude-ghost.useWorkspaceGuidelines: boolean (default true)
- Setting claude-ghost.workspaceGuidelinesPath: string (default "docs/guidelines") to support repos that put them elsewhere
- Slots into the ContextBuilder abstraction from item 7 as a dedicated provider

 ---
Tier 3 — UX / operational

9. "Regenerate" command

One keystroke to discard and re-roll the last completion (optionally with a "try again, different approach" nudge). Today the user has to dismiss + retrigger.

- New command claude-ghost.regenerate
- Keybinding Cmd+Shift+R / Ctrl+Alt+R (verify no collision)
- Dismisses current ghost, passes { hint: "generate a different approach than last time" } to provider.setNextTrigger, triggers inline suggest
- Log line: regenerate (previous len=N)
- Verify it plays nicely with #inflight abort — the old in-flight is cancelled before the new one starts

10. Local metrics

~/.claude-ghost/metrics.jsonl: completions, accepts, partials, declines, TTFT, decline reasons. No upload; just a personal file you can jq against. Helps tune model/effort empirically.

- Append one JSONL line per completion: {ts, model, effort, ttftMs, totalMs, completionLen, outcome: "accepted"|"partial"|"declined"|"cancelled"|"failed", declineReason?}
- Rotate at 10 MB (metrics.jsonl → metrics.jsonl.1)
- Setting claude-ghost.localMetrics: boolean (default false — opt-in)
- Command claude-ghost.showMetricsSummary — quick-pick style summary for the last 24 h / 7 d
- Document the schema in README so users know what's captured

11. Prompt-caching discipline

Restructure buildPrompt so the stable prefix (system + imports + neighbouring files) comes first and the volatile cursor-region comes last. Claude's prompt cache then hits 95 %+ on repeated triggers in the same file.

- Audit current buildPrompt output order — confirm volatile sections are last
- If extra-context lands, ensure chunks are ordered stable → volatile (visible/imports first, current file cursor region last)
- Verify cache hits in practice by inspecting result message cache fields in the session JSONL
- Log line: cache-hit ratio per completion when visible in the CLI response

12. Debounced in-flight dedup

If two identical prompts fire within 300 ms (common when the user double-triggers), return the in-flight result instead of interrupting and restarting.

- Hash the prompt (cheap: FNV-1a or just content length + first/last 128 chars)
- If a new trigger arrives with the same hash while #inflight is active, skip the abort and await the existing promise
- Cap dedup window at 300 ms to avoid stale reuse
- Log line: trigger deduped to in-flight (hash=… age=Nms)

 ---
Explicitly out of scope

Not adding — protects the single-purpose remit.

- Chat panel, agent mode, tool use, webview
- Whole-file diff/edit review
- PR / commit-message generation
- Test generation
- Refactor commands
- Workspace indexing (embeddings, vector store, background crawl)

If any of these become desirable later, they belong in a separate extension that calls claude directly.

 ---
Verification — end-to-end test story per tier

- Tier 1 — open two related files; trigger completion in one that references a symbol defined in the other. Confirm cross-file suggestion quality lifts. Toggle each setting off and confirm degradation matches expectation. npm test extended test count + make package.
- Tier 2 — rename an imported function and confirm the completion now honours the new signature (LSP resolution). Make a pending edit and re-trigger — completion should acknowledge the in-progress change.
- Tier 3 — repeatedly trigger with no edit; confirm dedup log fires. Turn on local metrics, run for a day, inspect JSONL with jq.

For every shipped piece: npm run compile && npm test && make package, then hand VSIX to the test user for a day of real-world use before promoting the next piece.

 ---
Order of operations

1. DONE — ghost-suppression bug resolved in v1.0.2
2. Ship Tier 1 item 3 (language-aware prompts) — smallest surface, lowest risk → patch release
3. Ship Tier 1 item 2 (selection-as-hint) — trivial → patch release
4. Ship Tier 1 item 1 (visible/recent context) — introduces ContextBuilder seam → 1.1.0
5. Ship Tier 1 item 4 (hover type info) → 1.2.0
6. Reassess — Tier 2 worth it? Or are completions good enough? Tier 2 item 8 (workspace-guideline ingestion) is the strongest candidate for the inshur-platform user; consider jumping to it ahead of items 5–7 if manual nudges from item 3 feel too coarse.

Critical files for Tier 1 work

- src/prompt.ts — prompt builder, system prompt
- src/provider.ts — completion provider, wires context in
- src/commands.ts — trigger entry points (selection-as-hint lives here)
- src/extension.ts — event wiring, recent-edits ring buffer
- src/state.ts — settings constants (CFG keys)
- src/sessionManager.ts — session spawn; system prompt decided here
- package.json — new settings under contributes.configuration.properties
- src/test/prompt.test.ts + new src/test/context.test.ts — tests
