import * as vscode from "vscode";
import type { ContextChunk } from "../context";
import type { ProviderOverrides } from "../provider";
import { CFG } from "../state";

// A small, intentionally conservative keyword / builtin set. Language-specific
// refinements are handled by joining this with a per-language extra set.
const UNIVERSAL_STOPWORDS = new Set([
  "true", "false", "null", "undefined", "this", "self", "super", "new",
  "if", "else", "for", "while", "return", "break", "continue", "switch",
  "case", "default", "try", "catch", "finally", "throw", "in", "of",
  "as", "is", "do", "from", "import", "export", "const", "let", "var",
  "function", "class", "interface", "type", "enum", "struct", "public",
  "private", "protected", "static", "void", "async", "await", "yield",
  "with", "pass", "lambda", "def", "elif", "and", "or", "not", "None",
  "True", "False", "use", "pub", "fn", "mut", "impl", "trait", "package",
  "namespace", "using", "nil",
]);

const JS_BUILTINS = new Set([
  "console", "Math", "Object", "Array", "String", "Number", "Boolean",
  "JSON", "Error", "Promise", "Map", "Set", "Symbol", "Date", "RegExp",
  "process", "require", "module", "exports",
]);

function stopwordsFor(_languageId: string): Set<string> {
  const set = new Set(UNIVERSAL_STOPWORDS);
  for (const b of JS_BUILTINS) set.add(b);
  return set;
}

const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

export interface ResolvedLocation {
  uri: vscode.Uri;
  range: vscode.Range;
}

// LRU cache of identifier resolutions. Keyed by `uri|line|word` so edits to a
// line bust the entry for that word (the line number is part of the key — the
// calling position drives the key).
interface CacheEntry {
  locations: ResolvedLocation[];
  insertedAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 50;

// Wire once: invalidate any cached entry whose defining URI overlaps with the
// changed document. Conservative — we flush every entry whose ResolvedLocation
// points into the changed URI. Keeps memory bounded; the next lookup repays.
let listenerWired = false;
function wireInvalidation(): void {
  if (listenerWired) return;
  try {
    vscode.workspace.onDidChangeTextDocument((event) => {
      const changed = event.document.uri.toString();
      for (const [key, entry] of cache) {
        if (entry.locations.some((l) => l.uri.toString() === changed)) {
          cache.delete(key);
        }
        // Also bust entries keyed on the changed URI (word-defined-here).
        if (key.startsWith(changed + "|")) cache.delete(key);
      }
    });
  } catch {
    // Not in an extension host (tests) — skip silently.
  }
  listenerWired = true;
}

function cacheGet(key: string): ResolvedLocation[] | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  // Touch: re-insert to move to MRU end.
  cache.delete(key);
  cache.set(key, e);
  return e.locations;
}

function cacheSet(key: string, locations: ResolvedLocation[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { locations, insertedAt: Date.now() });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Test-only reset.
export function _resetSymbolsCacheForTests(): void {
  cache.clear();
}

export function _symbolsCacheSize(): number {
  return cache.size;
}

function basename(fsPath: string): string {
  return fsPath.split(/[\\/]/).pop() ?? fsPath;
}

function headLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(0, n).join("\n");
}

export type CommandRunner = (cmd: string, ...args: unknown[]) => Thenable<unknown>;

interface Candidate {
  word: string;
  line: number;
  character: number;
}

function collectCandidates(
  document: vscode.TextDocument,
  position: vscode.Position,
): Candidate[] {
  const startLine = Math.max(0, position.line - 10);
  const endLine = Math.min(document.lineCount - 1, position.line + 10);
  const stops = stopwordsFor(document.languageId);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    const text = document.lineAt(ln).text;
    IDENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENT_RE.exec(text)) !== null) {
      const word = m[0];
      if (word.length < 4) continue;
      if (/^\d/.test(word)) continue;
      if (stops.has(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      out.push({ word, line: ln, character: m.index });
      if (out.length >= 15) return out;
    }
  }
  return out;
}

function normaliseDefLocations(
  raw: unknown,
): ResolvedLocation[] {
  if (!Array.isArray(raw)) return [];
  const out: ResolvedLocation[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    // vscode.Location = { uri, range }
    if (obj.uri && obj.range) {
      out.push({
        uri: obj.uri as vscode.Uri,
        range: obj.range as vscode.Range,
      });
      continue;
    }
    // vscode.LocationLink = { targetUri, targetRange, ... }
    if (obj.targetUri && obj.targetRange) {
      out.push({
        uri: obj.targetUri as vscode.Uri,
        range: obj.targetRange as vscode.Range,
      });
    }
  }
  return out;
}

export async function collectSymbols(
  document: vscode.TextDocument,
  position: vscode.Position,
  cfg: vscode.WorkspaceConfiguration,
  overrides: ProviderOverrides | null,
  skipUris?: Set<string>,
  commandRunner?: CommandRunner,
  openTextDocument?: (uri: vscode.Uri) => Thenable<vscode.TextDocument>,
  logger?: (msg: string) => void,
): Promise<ContextChunk[]> {
  wireInvalidation();

  const settingOn = cfg.get<boolean>(CFG.useSymbolResolution, true);
  const forced = overrides?.symbols === true;
  const forcedOff = overrides?.symbols === false;
  if (forcedOff) return [];
  if (!settingOn && !forced) return [];

  const maxFiles = cfg.get<number>(CFG.symbolResolutionMaxFiles, 6);
  const runCmd: CommandRunner =
    commandRunner ??
    ((cmd, ...args) => vscode.commands.executeCommand(cmd, ...args));
  const openDoc = openTextDocument ?? ((uri) => vscode.workspace.openTextDocument(uri));

  const candidates = collectCandidates(document, position);
  if (candidates.length === 0) return [];

  const startedAt = Date.now();
  const docUriStr = document.uri.toString();
  let resolvedCount = 0;
  let cacheHits = 0;

  const lookups = candidates.map(async (c) => {
    const key = `${docUriStr}|${c.line}|${c.word}`;
    const cached = cacheGet(key);
    if (cached) {
      cacheHits++;
      return cached;
    }
    try {
      const raw = await runCmd(
        "vscode.executeDefinitionProvider",
        document.uri,
        new vscode.Position(c.line, c.character),
      );
      const locs = normaliseDefLocations(raw);
      cacheSet(key, locs);
      return locs;
    } catch {
      cacheSet(key, []);
      return [];
    }
  });

  const settled = await Promise.allSettled(lookups);
  const allLocations: ResolvedLocation[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value.length > 0) {
      resolvedCount++;
      allLocations.push(...s.value);
    }
  }

  // Dedupe by URI; drop current file; drop skipUris; cap to maxFiles.
  const seen = new Set<string>();
  const picked: vscode.Uri[] = [];
  for (const loc of allLocations) {
    const u = loc.uri.toString();
    if (u === docUriStr) continue;
    if (skipUris?.has(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    picked.push(loc.uri);
    if (picked.length >= maxFiles) break;
  }

  const chunks: ContextChunk[] = [];
  for (const uri of picked) {
    try {
      const doc = await openDoc(uri);
      const text = headLines(doc.getText(), 40);
      chunks.push({
        source: "symbols",
        label: basename(doc.fileName),
        language: doc.languageId,
        text,
      });
    } catch {
      // unreadable — skip
    }
  }

  const latencyMs = Date.now() - startedAt;
  logger?.(
    `symbol-resolution (resolved=${resolvedCount}/${candidates.length}, cached=${cacheHits}, files=${chunks.length}, latencyMs=${latencyMs})`,
  );

  return chunks;
}
