import * as vscode from "vscode";
import type { ContextChunk } from "../context";
import type { ProviderOverrides } from "../provider";
import { CFG } from "../state";

// Ring buffer of recently-edited documents — wired from
// `src/extension.ts::onDidChangeTextDocument`. The buffer deliberately
// records OTHER documents (not the actively-edited file), because the
// active doc is already the primary prompt content; recent edits are
// useful as cross-file signal.
const RECENT_CAP = 5;
const recentUris: string[] = [];

// Public so extension.ts can call it from the text-change handler. Idempotent
// for repeated edits to the same doc — de-dupes by uri (most recent wins).
export function recordRecentEdit(doc: vscode.TextDocument): void {
  const uri = doc.uri.toString();
  const idx = recentUris.indexOf(uri);
  if (idx >= 0) recentUris.splice(idx, 1);
  recentUris.unshift(uri);
  while (recentUris.length > RECENT_CAP) recentUris.pop();
}

// Test-only: inspect the ring-buffer contents. Not exported for runtime.
export function getRecentRingBuffer(): string[] {
  return [...recentUris];
}

// Test-only: wipe state between cases.
export function _resetRecentRingBufferForTests(): void {
  recentUris.length = 0;
}

type Mode = "off" | "recent" | "visible" | "visible+recent";

function resolveMode(
  cfg: vscode.WorkspaceConfiguration,
  overrides: ProviderOverrides | null,
): Mode {
  const setting = cfg.get<Mode>(CFG.extraContext, "off");
  const forcedVisible = overrides?.visible === true;
  const forcedRecent = overrides?.recent === true;
  const disabledVisible = overrides?.visible === false;
  const disabledRecent = overrides?.recent === false;

  // Expand setting into independent visible/recent flags, then apply overrides.
  let visible = setting === "visible" || setting === "visible+recent";
  let recent = setting === "recent" || setting === "visible+recent";
  if (forcedVisible) visible = true;
  if (forcedRecent) recent = true;
  if (disabledVisible) visible = false;
  if (disabledRecent) recent = false;
  if (visible && recent) return "visible+recent";
  if (visible) return "visible";
  if (recent) return "recent";
  return "off";
}

function basename(fsPath: string): string {
  return fsPath.split(/[\\/]/).pop() ?? fsPath;
}

function headLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(0, n).join("\n");
}

interface Candidate {
  uri: string;
  source: "visible" | "recent";
  priority: number; // lower = drop first
  doc: vscode.TextDocument;
}

export interface VisibleRecentDeps {
  openTextDocument?: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;
  visibleEditors?: () => readonly vscode.TextEditor[];
}

export async function collectVisibleRecent(
  document: vscode.TextDocument,
  _position: vscode.Position,
  cfg: vscode.WorkspaceConfiguration,
  overrides: ProviderOverrides | null,
  deps: VisibleRecentDeps = {},
  logger?: (msg: string) => void,
): Promise<ContextChunk[]> {
  const mode = resolveMode(cfg, overrides);
  if (mode === "off") return [];

  const budget = cfg.get<number>(CFG.extraContextMaxBytes, 30000);
  const openDoc = deps.openTextDocument ?? ((uri) => vscode.workspace.openTextDocument(uri));
  const getVisible = deps.visibleEditors ?? (() => vscode.window.visibleTextEditors);

  const activeUri = document.uri.toString();
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  seen.add(activeUri);

  // Visible first — so priority stratification is obvious: visible > recent.
  if (mode === "visible" || mode === "visible+recent") {
    const vis = getVisible();
    let added = 0;
    for (const ed of vis) {
      if (added >= 3) break;
      const uri = ed.document.uri.toString();
      if (seen.has(uri)) continue;
      seen.add(uri);
      candidates.push({
        uri,
        source: "visible",
        priority: 100 - added, // higher = keep longer
        doc: ed.document,
      });
      added++;
    }
  }

  if (mode === "recent" || mode === "visible+recent") {
    let added = 0;
    for (const uri of recentUris) {
      if (added >= RECENT_CAP) break;
      if (seen.has(uri)) continue;
      seen.add(uri);
      try {
        const doc = await openDoc(vscode.Uri.parse(uri));
        candidates.push({
          uri,
          source: "recent",
          priority: 50 - added,
          doc,
        });
        added++;
      } catch {
        // The doc may have been closed or invalidated; silently skip.
      }
    }
  }

  // Build chunks, then apply byte budget dropping lowest-priority first.
  const chunks: (ContextChunk & { _priority: number })[] = [];
  for (const c of candidates) {
    const text = headLines(c.doc.getText(), 300);
    chunks.push({
      source: c.source,
      label: basename(c.doc.fileName),
      language: c.doc.languageId,
      text,
      _priority: c.priority,
    });
  }

  // Drop-from-lowest-priority until within budget.
  const sumBytes = (arr: { text: string }[]): number =>
    arr.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
  while (chunks.length > 0 && sumBytes(chunks) > budget) {
    let worstIdx = 0;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i]._priority < chunks[worstIdx]._priority) worstIdx = i;
    }
    chunks.splice(worstIdx, 1);
  }

  const visibleCount = chunks.filter((c) => c.source === "visible").length;
  const recentCount = chunks.filter((c) => c.source === "recent").length;
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  logger?.(
    `visible/recent: ${chunks.length} chunks (${totalChars} chars, visible=${visibleCount} recent=${recentCount})`,
  );

  return chunks.map(({ _priority, ...rest }) => {
    void _priority;
    return rest;
  });
}
