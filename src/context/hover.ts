import * as vscode from "vscode";
import type { ContextChunk } from "../context";
import type { ProviderOverrides } from "../provider";
import { CFG } from "../state";

const TYPED_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "python",
  "go",
  "java",
  "kotlin",
  "csharp",
  "swift",
]);

const HOVER_CAP = 500;

// The accessor must be immediately before the cursor (no whitespace).
// Supports `.`, `->`, `::`. The captured group is the matched accessor itself
// so the caller can log which one triggered.
const ACCESSOR_RE = /(\.|->|::)$/;

// Used to find the identifier BEFORE the accessor. Walks backwards from the
// character just before the accessor.
function identifierBefore(
  lineText: string,
  accessorEndCol: number,
): { word: string; column: number } | null {
  // accessorEndCol is where the accessor starts (character column).
  // Walk backwards over [A-Za-z0-9_] run.
  const end = accessorEndCol;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_]/.test(lineText[start - 1])) start--;
  if (start === end) return null;
  return { word: lineText.slice(start, end), column: start };
}

export type CommandRunner = (cmd: string, ...args: unknown[]) => Thenable<unknown>;

// Pull the first raw markdown string out of an array of vscode.Hover entries.
// Each Hover has .contents: (string | MarkdownString)[]. Either can appear.
function extractFirstMarkdown(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    const contents = (h as { contents?: unknown }).contents;
    if (!Array.isArray(contents)) continue;
    for (const c of contents) {
      if (typeof c === "string" && c.trim()) return c;
      if (c && typeof c === "object" && typeof (c as { value?: unknown }).value === "string") {
        const v = (c as { value: string }).value;
        if (v.trim()) return v;
      }
    }
  }
  return null;
}

// Strip triple-backtick fences (```lang\n…\n```) — keep the body. Also drop
// trailing metadata lines that some language servers append.
export function stripFences(markdown: string): string {
  const m = markdown.match(/```[\w-]*\n([\s\S]*?)\n?```/);
  if (m) return m[1].trim();
  return markdown.trim();
}

export async function collectHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  cfg: vscode.WorkspaceConfiguration,
  _overrides: ProviderOverrides | null,
  commandRunner?: CommandRunner,
  logger?: (msg: string) => void,
): Promise<ContextChunk[]> {
  if (!cfg.get<boolean>(CFG.useTypeInfo, true)) return [];
  if (!TYPED_LANGUAGES.has(document.languageId)) return [];

  // Check what's immediately before the cursor on the current line.
  const line = document.lineAt(position.line);
  const before = line.text.slice(0, position.character);
  const match = ACCESSOR_RE.exec(before);
  if (!match) return [];
  const accessor = match[1];
  const accessorStartCol = before.length - accessor.length;

  const ident = identifierBefore(line.text, accessorStartCol);
  if (!ident) return [];

  const runCmd: CommandRunner =
    commandRunner ??
    ((cmd, ...args) => vscode.commands.executeCommand(cmd, ...args));

  let raw: unknown;
  try {
    raw = await runCmd(
      "vscode.executeHoverProvider",
      document.uri,
      new vscode.Position(position.line, ident.column),
    );
  } catch {
    return [];
  }

  const md = extractFirstMarkdown(raw);
  if (!md) return [];
  let body = stripFences(md);
  if (!body) return [];
  if (body.length > HOVER_CAP) body = body.slice(0, HOVER_CAP);

  logger?.(`receiver-hover (len=${body.length}, accessor="${accessor}")`);

  return [
    {
      source: "hover",
      label: "receiver type",
      language: document.languageId,
      text: body,
    },
  ];
}
