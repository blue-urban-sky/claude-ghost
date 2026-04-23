import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ContextChunk } from "./context";

export interface PromptConfig {
  contextMaxBytes: number;
  contextLines: number;
  hint?: string;
  maximalist?: { task: string };
  extraContext?: ContextChunk[];
  languageId?: string;
}

export const SYSTEM_PROMPT = [
  "You are an inline code completion engine, like GitHub Copilot.",
  "Each user message contains a file with «CURSOR» marking where new code goes.",
  "Your reply is inserted verbatim at «CURSOR» — treat it like a fill-in-the-middle.",
  "",
  "If the message contains a <hint>, follow it — it's a one-shot instruction from the user (e.g., 'use async/await', 'return early on null', 'make it recursive').",
  "",
  "Strict rules:",
  "- Output ONLY the raw text to insert. Nothing else.",
  "- Never include markdown fences (no ```, no ~~~), prose, preambles (no 'Here's', 'Sure', 'This'), or explanations.",
  "- Never re-emit the input scaffolding. Tags like <file>, <hint>, <task>, <mode>, «CURSOR» are INPUT ONLY — never appear in your output.",
  "- Never add trailing commentary like '(no additional code needed)', '// end of file', '// ...', or similar meta notes.",
  "- Never re-emit the prefix or the suffix. Your output joins them seamlessly.",
  "- Match the surrounding code's style (indentation, quotes, semicolons, naming).",
  "- Prefer short to medium completions: one expression, one statement, one small block, or a function",
  "- If no useful completion is possible, reply with a single space.",
  "- Do not return completions under 5 char, look for a longer response",
  "",
  "Example:",
  "Input:",
  "<file name=\"math.ts\" language=\"typescript\">",
  "export function add(a: number, b: number) {",
  "  return «CURSOR»",
  "}",
  "</file>",
  "Output:",
  "a + b;",
].join("\n");

export const MAXIMALIST_SYSTEM_PROMPT = [
  "You are a maximalist code generator. The user wants a COMPLETE, substantial implementation written into their file, produced from a nearby source comment describing the task.",
  "",
  "Each user message contains:",
  "- <task> — the source comment to expand (e.g. 'create a class for managing a user crud system').",
  "- <file name=\"…\" language=\"…\"> — the full file with «CURSOR» marking where your output is inserted verbatim.",
  "",
  "What to produce:",
  "- A thorough implementation addressing the <task>: classes, methods, types, helpers, imports (if missing).",
  "- Stay inside this one file. Do not reference files you cannot see.",
  "- Include concise comment blocks explaining integration: where this is imported, how to wire it, required deps or environment, caveats. Use only the target file's native comment syntax.",
  "- Output can be long — prefer thoroughness over terseness.",
  "",
  "Strict output rules:",
  "- Output ONLY the raw code to insert at «CURSOR». Nothing else.",
  "- Never wrap output in markdown fences (no ```, no ~~~).",
  "- Never include prose or preambles outside code comments.",
  "- Never re-emit the input scaffolding. Tags like <file>, <task>, <mode>, «CURSOR» are INPUT ONLY.",
  "- Never add trailing meta commentary like '(no additional code needed)' or '// end of file'.",
  "- Match the surrounding code's style (indentation, quotes, semicolons, naming).",
].join("\n");

// Strips tokens that would collide with our scaffolding. «CURSOR» inside
// embedded file content becomes a zero-width-space-escaped form so the CLI
// can't be tricked by file contents containing our markers. We also neutralise
// the per-request nonce if an attacker's file contents happen to include it.
function neutraliseScaffolding(content: string, nonce: string): string {
  const zwsp = "​";
  return content
    .replace(/«CURSOR»/g, `«${zwsp}CURSOR${zwsp}»`)
    .split(nonce)
    .join(`${nonce[0]}${zwsp}${nonce.slice(1)}`);
}

export function buildPrompt(
  document: vscode.TextDocument,
  position: vscode.Position,
  config: PromptConfig,
): string {
  const full = document.getText();
  const cursorOffset = document.offsetAt(position);
  const languageId = document.languageId;
  const fileName = document.fileName.split(/[\\/]/).pop() ?? "untitled";

  let prefix: string;
  let suffix: string;

  if (Buffer.byteLength(full, "utf8") <= config.contextMaxBytes) {
    prefix = full.slice(0, cursorOffset);
    suffix = full.slice(cursorOffset);
  } else {
    const startLine = Math.max(0, position.line - config.contextLines);
    const endLine = Math.min(
      document.lineCount - 1,
      position.line + config.contextLines,
    );
    const startOffset = document.offsetAt(new vscode.Position(startLine, 0));
    const endOffset = document.offsetAt(document.lineAt(endLine).range.end);
    prefix = full.slice(startOffset, cursorOffset);
    suffix = full.slice(cursorOffset, endOffset);
  }

  const nonce = randomBytes(4).toString("hex");
  const cleanPrefix = neutraliseScaffolding(prefix, nonce);
  const cleanSuffix = neutraliseScaffolding(suffix, nonce);
  const cleanTask = config.maximalist
    ? neutraliseScaffolding(config.maximalist.task, nonce)
    : null;
  const cleanHint = config.hint && config.hint.trim()
    ? neutraliseScaffolding(config.hint.trim(), nonce)
    : null;

  // Prompt-cache discipline: order sections stable → volatile. Anthropic's
  // prompt cache keys on longest-common-prefix, so putting stable-across-
  // triggers sections first (extra context snapshots, language style) and
  // volatile per-call sections (task, hint, current file cursor region) last
  // maximises cache hits when the user re-triggers with only cursor moves.
  const lines: string[] = [];
  // --- stable prefix ---
  if (config.extraContext && config.extraContext.length > 0) {
    for (const chunk of config.extraContext) {
      const cleanText = neutraliseScaffolding(chunk.text, nonce);
      lines.push(
        `<file-${nonce} name="${chunk.label}" language="${chunk.language ?? ""}" role="context">`,
        cleanText,
        `</file-${nonce}>`,
      );
    }
  }
  if (config.languageId) {
    const nudge = languageStyleFor(config.languageId);
    if (nudge) {
      lines.push(`<style lang="${config.languageId}">${nudge}</style>`);
    }
  }
  // --- volatile tail ---
  if (cleanTask) {
    lines.push(`<task-${nonce}>${cleanTask}</task-${nonce}>`);
  }
  if (cleanHint) {
    lines.push(`<hint-${nonce}>${cleanHint}</hint-${nonce}>`);
  }
  lines.push(
    `<file-${nonce} name="${fileName}" language="${languageId}">`,
    `${cleanPrefix}«CURSOR»${cleanSuffix}`,
    `</file-${nonce}>`,
  );
  return lines.join("\n");
}

// Per-language style nudges, kept generic (no org-specific content). These
// target things the model commonly gets wrong in inline completion — not
// broader architecture / testing advice which would bloat the prompt.
// Each nudge is under 200 chars.
const LANGUAGE_STYLE: Record<string, string> = {
  typescript:
    "Prefer const and precise types; avoid any unless unavoidable. Don't reintroduce duplicate imports; keep existing import order. Use named exports consistently with the rest of the file.",
  typescriptreact:
    "Prefer const and precise types; avoid any unless unavoidable. Don't reintroduce duplicate imports; keep existing import order. Use named exports consistent with the file.",
  javascript:
    "Prefer const/let over var. Preserve the file's existing module style (CJS vs ESM) — don't mix. Don't reintroduce duplicate imports; keep existing import order.",
  javascriptreact:
    "Prefer const/let over var. Preserve the file's existing module style (CJS vs ESM) — don't mix. Don't reintroduce duplicate imports; keep existing import order.",
  python:
    "No semicolons. Preserve import order (stdlib, third-party, local). Use type hints when surrounding code uses them. Keep the existing docstring style (triple-quoted, same convention).",
  java:
    "Honour the existing package and import style. No wildcard imports unless the file already uses them. Keep annotations on their own line. Don't insert stray semicolons.",
  kotlin:
    "Prefer val over var. Avoid !! — use ?., ?:, or value?.let { }. Don't reintroduce wildcard imports. Use structured coroutine scopes, not GlobalScope.",
  go:
    "No unused imports. gofmt-style braces on the same line. Short variable names in short scopes. Early return on `if err != nil`.",
  shellscript:
    "In bash, prefer [[ ]] over [ ]. Always quote variable expansions (\"$var\"). Only put set -euo pipefail at the file head — never mid-script.",
  terraform:
    "Preserve resource naming conventions already used in the file. Align = in blocks where the surrounding file aligns them. Don't reorder top-level blocks.",
};

export function languageStyleFor(languageId: string): string {
  return LANGUAGE_STYLE[languageId] ?? "";
}

// Cache compiled comment-marker regexes per language so we don't recompile on
// every keystroke.
const commentRegexCache = new Map<string, RegExp | null>();

function commentRegexFor(languageId: string): RegExp | null {
  if (commentRegexCache.has(languageId)) {
    return commentRegexCache.get(languageId) ?? null;
  }
  const marker = commentMarkerFor(languageId);
  if (!marker) {
    commentRegexCache.set(languageId, null);
    return null;
  }
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s?(.*)$`);
  commentRegexCache.set(languageId, re);
  return re;
}

export function findNearbyComment(
  document: vscode.TextDocument,
  position: vscode.Position,
): string | null {
  const re = commentRegexFor(document.languageId);
  if (!re) return null;
  const MAX_LOOKBACK = 10;

  let endLine = position.line;
  if (!re.test(document.lineAt(endLine).text)) {
    let found = -1;
    for (let i = 1; i <= MAX_LOOKBACK && endLine - i >= 0; i++) {
      if (re.test(document.lineAt(endLine - i).text)) {
        found = endLine - i;
        break;
      }
    }
    if (found < 0) return null;
    endLine = found;
  }
  let startLine = endLine;
  while (startLine > 0 && re.test(document.lineAt(startLine - 1).text)) {
    startLine--;
  }
  const parts: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const m = re.exec(document.lineAt(i).text);
    if (m && m[1].trim()) parts.push(m[1].trim());
  }
  return parts.length ? parts.join(" ") : null;
}

export function commentMarkerFor(languageId: string): string | null {
  const slashSlash = new Set([
    "typescript", "javascript", "typescriptreact", "javascriptreact",
    "c", "cpp", "csharp", "java", "go", "rust", "swift", "kotlin",
    "scala", "dart", "php", "groovy", "objective-c", "objective-cpp",
  ]);
  const hash = new Set([
    "python", "ruby", "shellscript", "perl", "yaml", "toml",
    "dockerfile", "makefile", "elixir", "r", "tcl", "nim",
  ]);
  const dashDash = new Set(["sql", "lua", "haskell", "ada"]);
  if (slashSlash.has(languageId)) return "//";
  if (hash.has(languageId)) return "#";
  if (dashDash.has(languageId)) return "--";
  return null;
}

// Phrases that indicate meta-commentary rather than real code in a trailing
// parenthetical. Legitimate trailing `foo(args)` calls won't match.
const META_COMMENTARY = [
  "end of",
  "continued",
  "no additional",
  "rest of",
  "rest of the",
  "no more",
  "no further",
  "..",
  "…",
  "truncated",
];

export interface RefactorPromptConfig {
  contextMaxBytes: number;
  contextLines: number;
  languageId?: string;
  extraContext?: ContextChunk[];
  hint?: string;
}

// Refactor prompt: the user has selected a block of code and wants it
// rewritten. Presents the full file (or a windowed view) with the selection
// tagged between <selection-rewrite> markers and a «CURSOR» placed right
// after the closing tag. The warm session's system prompt already tells the
// model to output at «CURSOR», so a direct instruction at the tail of the
// user message steers it to produce the replacement for the marked block.
// The replacement is applied to the VS Code selection range via the
// Refactor Preview pane, not by parsing the model output.
export function buildRefactorPrompt(
  document: vscode.TextDocument,
  selectionRange: vscode.Range,
  config: RefactorPromptConfig,
): string {
  const full = document.getText();
  const selStart = document.offsetAt(selectionRange.start);
  const selEnd = document.offsetAt(selectionRange.end);
  const selection = full.slice(selStart, selEnd);
  const languageId = document.languageId;
  const fileName = document.fileName.split(/[\\/]/).pop() ?? "untitled";

  let prefix: string;
  let suffix: string;
  if (Buffer.byteLength(full, "utf8") <= config.contextMaxBytes) {
    prefix = full.slice(0, selStart);
    suffix = full.slice(selEnd);
  } else {
    // Centre the window on the selection's own line range.
    const startLine = Math.max(0, selectionRange.start.line - config.contextLines);
    const endLine = Math.min(
      document.lineCount - 1,
      selectionRange.end.line + config.contextLines,
    );
    const startOffset = document.offsetAt(new vscode.Position(startLine, 0));
    const endOffset = document.offsetAt(document.lineAt(endLine).range.end);
    prefix = full.slice(startOffset, selStart);
    suffix = full.slice(selEnd, endOffset);
  }

  const nonce = randomBytes(4).toString("hex");
  const neutral = (s: string): string => neutraliseScaffolding(s, nonce);

  const lines: string[] = [];
  // Stable prefix first for cache discipline.
  if (config.extraContext && config.extraContext.length > 0) {
    for (const chunk of config.extraContext) {
      const cleanText = neutral(chunk.text);
      lines.push(
        `<file-${nonce} name="${chunk.label}" language="${chunk.language ?? ""}" role="context">`,
        cleanText,
        `</file-${nonce}>`,
      );
    }
  }
  if (config.languageId) {
    const nudge = languageStyleFor(config.languageId);
    if (nudge) {
      lines.push(`<style lang="${config.languageId}">${nudge}</style>`);
    }
  }
  const cleanHint = config.hint && config.hint.trim()
    ? neutral(config.hint.trim())
    : null;
  if (cleanHint) {
    lines.push(`<hint-${nonce}>${cleanHint}</hint-${nonce}>`);
  }
  lines.push(
    `<file-${nonce} name="${fileName}" language="${languageId}">`,
    neutral(prefix),
    `<selection-rewrite-${nonce}>`,
    neutral(selection),
    `</selection-rewrite-${nonce}>`,
    `«CURSOR»`,
    neutral(suffix),
    `</file-${nonce}>`,
    ``,
    `Output the code that should replace the block inside <selection-rewrite-${nonce}>…</selection-rewrite-${nonce}>. Insert at «CURSOR». Output ONLY the replacement code — no prose, no markdown fences, no explanation, no commentary.`,
  );
  return lines.join("\n");
}

// Longest suffix of `completion` that equals a prefix of `after`. Used by the
// provider to size the replacement range: if the model re-emits characters
// that already exist right of the cursor (common: trailing `)`, `}`, `;`),
// the range covers that exact overlap so accepting the ghost doesn't
// duplicate them. When overlap is 0 we end up with a pure insertion at the
// cursor — which is what mid-line completions need to render at all.
export function completionOverlap(completion: string, after: string): number {
  const max = Math.min(completion.length, after.length);
  for (let n = max; n > 0; n--) {
    if (completion.endsWith(after.slice(0, n))) return n;
  }
  return 0;
}

export function cleanCompletion(raw: string): string {
  let out = raw;
  // Strip leaked input scaffolding (both vanilla and nonce-suffixed forms).
  out = out.replace(/<\/?(hint|task|mode|file)(-[a-f0-9]+)?[^>]*>/gi, "");
  // Prefer the first fenced code block if present (handles fences with prose
  // around them).
  const fence = out.match(/```[\w-]*\n([\s\S]*?)\n?```/);
  if (fence) {
    out = fence[1];
  }
  // Targeted strip: only remove a trailing parenthetical if its contents
  // clearly indicate meta-commentary. Previous heuristic was over-eager and
  // ate legitimate `foo(args)` trailing calls.
  out = out.replace(/\n?\s*\(([^)]{1,120})\)\s*$/u, (match, inside: string) => {
    const lower = inside.toLowerCase();
    for (const phrase of META_COMMENTARY) {
      if (lower.includes(phrase)) return "";
    }
    return match;
  });
  return out;
}
