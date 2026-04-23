Here is Claude's plan:                                                                                                                                                                                                                                                                                                                                                                                                                                                            

Claude Ghost — Roadmap & Future Enhancements

Context

Claude Ghost is single-purpose by design: warm claude subprocess, fill-in-the-middle prompt, stream to ghost text. Current prompt sees only the current file (whole file under 100 KB, otherwise ±100 lines around cursor). Claude's 200 k context is therefore ~90 % empty on every call, which caps suggestion quality for anything that touches multiple files or relies on type information.

This document tracks planned enhancements in three tiers. Each item is independently shippable. Tier ordering is by ROI — do Tier 1 in order, then stop and reassess.

Blocker — RESOLVED in v1.0.2. Root cause was not the VS Code render path; it was a range-calculation bug in the provider. Before v1.0.2, the accept-range was set from cursor to end-of-line unconditionally. Fine for EOL triggers (empty range = pure insertion) but broken for mid-line triggers — VS Code silently refused to render any ghost that would obliterate unrelated text further along the line. Fixed by sizing the range to the exact overlap between the completion's tail and the head of after-cursor text. See CHANGELOG.md [1.0.2] and src/prompt.ts::completionOverlap.

 ---
Tier 1 — high ROI, fits the single-purpose remit

1. Visible-editors + recent-edits context [TOGGLE]

Pull the first ~300 lines of each tab currently open and the last N files edited in this session. Two or three extra files almost always lift cross-file suggestion quality dramatically. Cost: one ContextBuilder module, ~60 lines, ~zero latency (we're already warm).

Design response to user feedback: concern that dozens of open tabs would swamp the prompt. Defaulting the setting to "off" (opt-in). When enabled, "recent" (ring buffer from onDidChangeTextDocument) is the preferred mode; "visible" is available but treats tab count as a soft cap and drops tabs in reverse last-focused order. Item 5 (LSP symbol resolution) is the preferred targeted alternative when this feels noisy.

- Add src/context.ts exposing buildExtraContext(document, budgetChars): ContextChunk[] where ContextChunk = { source, label, text }
- Source 1 — vscode.window.visibleTextEditors, skip the active editor, cap at 3 tabs, take first 300 lines of each
- Source 2 — recent-edits ring buffer (last 5 documents), populated from the existing onDidChangeTextDocument handler in src/extension.ts
- Budget split: each enabled source gets extraContextMaxBytes / N; trim by head-lines to preserve imports/types at top
- Setting claude-ghost.extraContext: "off" | "recent" | "visible" | "visible+recent" (default "off")
- Setting claude-ghost.extraContextMaxBytes (default 30 000)
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

4. LSP-sourced type info [TOGGLE]

Design response to user feedback: "the IDE already shows hover — is this redundant?" The hover popup is rendered for the human; the model never sees it. For the model to use a type signature, we have to pull it from the LSP and embed it in the prompt. But the framing matters: at a blank cursor position (mid-line between tokens) there's no identifier to hover on, so the feature fires far less often than it first sounds. Narrowed to the one high-value case below.

When the cursor sits immediately after an accessor (. → :: ->), run one hover on the preceding identifier (the receiver). That's where typed-language completion quality lifts the most — the model sees the receiver's concrete type and narrows member suggestions accordingly.

- Helper getReceiverHover(document, position): string | null — only fires when text immediately before the cursor matches /[.]|->|::/$/
- Resolve the word before the accessor, call vscode.executeHoverProvider, pull the first markdown string, strip fences
- Fail-open: if no hover provider is registered or the call throws, return null
- Cap extracted hover at ~500 chars
- Embed in prompt as <receiver-type>…</receiver-type> block near the cursor
- Only fire when document.languageId is in the typed-languages set (TS/JS, Python with Pyright, Go, Rust, Java, Kotlin, C#, Swift)
- Log line: receiver-hover (len=N, source=<languageId>) when present
- Setting claude-ghost.useTypeInfo: boolean (default true — low firing rate, so bloat risk is minimal)
- Priority note: if item 5 (symbol resolution) delivers enough value, this item may be unnecessary. Ship item 5 first, reassess.

 ---
Tier 2 — worth doing after Tier 1 proves out

5. Symbol resolution via LSP [TOGGLE]

Design response to user feedback: "I like this better than all open editors (of which I often have dozens)." Promoted — this is the targeted alternative to item 1's bulk-tab approach. Demand-driven context: we only pull files the current cursor region actually references. Promoted in the order of operations; if it lands well it may obsolete item 1 entirely.

For the 5–10 identifiers in the ±10 lines around cursor, call executeDefinitionProvider, attach the first 40 lines of each defining file. Cost: latency spike on first call, then cache.

- Tokenise ±10 lines around cursor; dedupe to unique identifiers; exclude language keywords and common builtins
- For each, call vscode.executeDefinitionProvider
- Cache resolved definitions by (uri, line, word) → Location[] (LRU, ~50 entries); invalidate on the defining file's onDidChange
- For each definition URI, pull first 40 lines, dedupe against already-included extra-context chunks
- Add to ContextBuilder as SymbolResolutionProvider
- Setting claude-ghost.useSymbolResolution: boolean (default true)
- Setting claude-ghost.symbolResolutionMaxFiles: number (default 6) to cap fan-out
- Benchmark gate: additional latency under 300 ms on first call, under 50 ms cached
- Log line: symbol-resolution (resolved=N/M, cached=K, latencyMs=L)

6. Unstaged git diff of the current file [TOGGLE]

Design response to user feedback: "this could be a lot of data, maybe feed it through symbol resolution?" Agreed. The diff's value is signalling INTENT (what the user is currently changing), not re-delivering the file. Cut the cap dramatically and keep only hunk headers + changed lines, no surrounding context. Any referenced symbols get chased by item 5 automatically.

- Detect git repository using vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1)
- Pull the diff via the git extension API, not raw subprocess (handles non-standard repo layouts)
- Strip the diff: retain `@@` hunk headers, `+`/`-` lines only; discard context ` ` lines
- Embed as <pending-diff>…</pending-diff> block before the current file
- Cap aggressively at ~500 chars (was 3 000); if larger, keep the last N hunks only and log a note
- Setting claude-ghost.useGitDiff: boolean (default true)
- Interplay: identifiers appearing in the diff's +/- lines should preferentially feed item 5's symbol resolver (diff is a pointer, not a payload)

7. Budget-aware context assembly

Explicit ContextBuilder abstraction with pluggable providers (CurrentFile, VisibleEditors, RecentEdits, Hover, Imports, GitDiff) and a total character budget sliced by priority. Enables experimentation without rewrites each time.

- Define ContextProvider interface: { id: string; priority: number; build(document, position, budget): Promise<ContextChunk[]> }
- Refactor Tier 1 / Tier 2 sources into providers
- Total budget from contextMaxBytes; each provider is offered budget * (priority / sum) with rebate on unused
- Log line: context assembled: {currentFile=Nk, visible=Nk, recent=Nk, hover=Nk, imports=Nk, diff=Nk} total=Nk/Mk
- Setting claude-ghost.contextProviders: string[] to enable/disable individual providers

8. Workspace-guideline signal — two variants

Design response to user feedback: "I fear this may bloat the context and confuse; the guidelines are WIP and agentic-flow-oriented." Good call — peeking at the target repo's docs/guidelines/*.md confirmed: many sections are directives aimed at Claude-as-agent (commit rules, PR etiquette, tool usage), which are useless or harmful for inline completion. Two variants below; ship 8a if curation scales, fall back to 8b only if it doesn't.

8a. MANUAL CURATION (recommended)
- Use the guidelines docs as source material for the hand-written language nudges in item 3
- One-time distillation: extract only the code-style sections (null safety, import rules, immutability, formatting) and bake into languageStyleFor()
- Zero runtime bloat; no agentic content leaks into completion prompts
- Rebuild nudges when the guidelines docs change materially (doesn't happen often)
- Effectively folds into item 3's work — not a separate shippable piece

8b. AUTO-INGEST WITH STRICT FILTERING (fallback) [TOGGLE]
- Only ship this if the curated nudges in 8a prove too coarse
- Ingest only sections whose heading matches /\b(style|format|import|null|types?|naming)\b/i
- Hard cap 800 chars total (not per-file) — forces the filter to be discriminating
- Cache per-workspace; invalidate on document change within the guidelines directory
- Embed as <project-style source="…">…</project-style> block
- Setting claude-ghost.useWorkspaceGuidelines: boolean (default false)
- Setting claude-ghost.workspaceGuidelinesPath: string (default "docs/guidelines")

 ---
Tier 3 — UX / operational

9. Regenerate + one-shot context overrides (reuse existing keybinds)

Design response to user feedback: "we can reuse the existing keybind; the hint keybind would work well for toggling FLAGged providers one-shot." Both ideas adopted. No new keybinds.

Two distinct behaviours bolted onto the existing trigger / hint keys:

(a) Regenerate — when the plain trigger keybind fires while a ghost is already visible (provider.hasPending === true), treat it as a regenerate: dismiss current ghost, pass { hint: "generate a different approach than the previous suggestion" }, re-trigger inline suggest
  - No new command, no new keybind
  - Log line: regenerate (previous len=N)

(b) Prefix tokens in the hint dialog — the triggerWithHint input parses leading `+visible` / `+recent` / `+symbols` / `+diff` tokens and enables those FLAGged providers for THIS call only; the remainder of the input is the actual hint
  - Example: "+symbols use a Map instead" runs with useSymbolResolution forced on for this call, hint = "use a Map instead"
  - Example: "+visible +diff" with empty hint just expands context one-shot
  - Log line: hint overrides (providers=[symbols,diff], hint="…")
  - No permanent setting change; overrides clear after the completion settles

- Implementation: provider.setNextTrigger gains an optional `providerOverrides: { visible?, recent?, symbols?, diff? }` field
- Documented in README's Commands section — the prefix-token grammar is cheap to learn, keeps power under one key
- Interplay with item 12 (dedup): the regenerate path must bypass the dedup hash or it'll no-op on identical prompts

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
- Regenerate (item 9a) must bypass the dedup hash, otherwise it no-ops

 ---
Settings overview — FLAG toggles in one place

Every on/off setting introduced by this roadmap, collected for reference. All live under the claude-ghost.* namespace. Defaults are chosen to keep the baseline experience predictable (no bloat, no surprise network / LSP fan-out) and require explicit opt-in for wider-context features.

| Setting                                  | Type                                       | Default   | Item |
|------------------------------------------|--------------------------------------------|-----------|------|
| extraContext                             | "off" \| "recent" \| "visible" \| "visible+recent" | "off"     | 1    |
| extraContextMaxBytes                     | number                                     | 30000     | 1    |
| useTypeInfo                              | boolean                                    | true      | 4    |
| useSymbolResolution                      | boolean                                    | true      | 5    |
| symbolResolutionMaxFiles                 | number                                     | 6         | 5    |
| useGitDiff                               | boolean                                    | true      | 6    |
| contextProviders                         | string[]                                   | (all on)  | 7    |
| useWorkspaceGuidelines                   | boolean                                    | false     | 8b   |
| workspaceGuidelinesPath                  | string                                     | "docs/guidelines" | 8b |
| localMetrics                             | boolean                                    | false     | 10   |

All FLAGged providers are also reachable one-shot via prefix tokens on the triggerWithHint keybind (item 9): `+visible`, `+recent`, `+symbols`, `+diff`. That's the escape hatch when a setting is off but the user wants that extra context just for this completion.

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
Order of operations (revised from user feedback)

1. DONE — ghost-suppression bug resolved in v1.0.2
2. Ship Tier 1 item 3 (language-aware prompts, with 8a-style curation baked in) — smallest surface, lowest risk → patch release
3. Ship Tier 1 item 2 (selection-as-hint) — trivial → patch release
4. Ship Tier 2 item 5 (LSP symbol resolution) — user-preferred targeted context source; introduces ContextBuilder seam → 1.1.0
5. Ship Tier 1 item 1 (visible/recent, default off) — offered as an optional wider-net supplement to item 5 → 1.1.x
6. Ship Tier 3 item 9 (regenerate + prefix tokens) — unlocks one-shot opt-in for FLAGged providers → 1.2.0
7. Ship Tier 2 item 6 (git diff, aggressive cap) — cheap intent signal, relies on item 5 for any symbol chasing
8. Ship Tier 1 item 4 (receiver-hover) — evaluate value now that item 5 is in place; may be redundant
9. Reassess Tier 2 item 7 (budget-aware assembly) — only worth the refactor once 3+ context providers exist
10. 8b (auto-ingest) only if the 8a curation in item 3 proves too coarse

Critical files for Tier 1 work

- src/prompt.ts — prompt builder, system prompt
- src/provider.ts — completion provider, wires context in
- src/commands.ts — trigger entry points (selection-as-hint lives here)
- src/extension.ts — event wiring, recent-edits ring buffer
- src/state.ts — settings constants (CFG keys)
- src/sessionManager.ts — session spawn; system prompt decided here
- package.json — new settings under contributes.configuration.properties
- src/test/prompt.test.ts + new src/test/context.test.ts — tests
