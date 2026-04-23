import * as vscode from "vscode";
import type { ContextChunk } from "../context";
import type { ProviderOverrides } from "../provider";
import { CFG } from "../state";

const DIFF_CAP = 500;

// Minimal surface we use off the git extension API. The real type lives in
// the built-in vscode.git extension's d.ts, but re-declaring here keeps this
// file dependency-free.
interface GitRepository {
  rootUri: vscode.Uri;
  diffWithHEAD(path: string): Promise<string>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
  repositories: GitRepository[];
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

export type DiffFetcher = (document: vscode.TextDocument) => Promise<string | null>;

// Default fetcher — reaches into the built-in vscode.git extension. Swappable
// via dependency injection in tests.
const defaultDiffFetcher: DiffFetcher = async (document) => {
  try {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) return null;
    const api = ext.isActive ? ext.exports?.getAPI(1) : (await ext.activate())?.getAPI(1);
    if (!api) return null;
    const repo = api.getRepository(document.uri)
      ?? api.repositories.find((r) => document.uri.fsPath.startsWith(r.rootUri.fsPath))
      ?? null;
    if (!repo) return null;
    return await repo.diffWithHEAD(document.uri.fsPath);
  } catch {
    return null;
  }
};

// Strip a unified diff to just hunk headers and ± lines. Drops context lines
// (prefix space) and file-metadata chatter (---/+++). Keeps the diff useful
// as an intent signal without re-delivering file contents.
export function stripDiff(raw: string): { text: string; hunkCount: number } {
  const lines = raw.split("\n");
  const out: string[] = [];
  let hunkCount = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      out.push(line);
      hunkCount++;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      out.push(line);
    }
    // space-prefix context lines: dropped.
  }
  return { text: out.join("\n"), hunkCount };
}

// Apply a hard cap. Prefer keeping TRAILING hunks — they're most likely
// near the cursor's current intent. Drops hunks from the top until the
// combined size fits under the cap, adding a truncation marker.
export function capDiff(stripped: string, cap: number): string {
  if (stripped.length <= cap) return stripped;
  const lines = stripped.split("\n");
  // Walk backwards accumulating until near the cap, budgeting a short marker.
  const marker = "[…earlier hunks truncated]";
  const limit = cap - marker.length - 1;
  let acc: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const addLen = line.length + 1; // newline
    if (size + addLen > limit) break;
    acc.push(line);
    size += addLen;
  }
  acc.reverse();
  // Snap start to the first @@ so we don't begin mid-hunk.
  const firstHunk = acc.findIndex((l) => l.startsWith("@@"));
  if (firstHunk > 0) acc = acc.slice(firstHunk);
  return marker + "\n" + acc.join("\n");
}

export async function collectGitDiff(
  document: vscode.TextDocument,
  _position: vscode.Position,
  cfg: vscode.WorkspaceConfiguration,
  overrides: ProviderOverrides | null,
  diffFetcher: DiffFetcher = defaultDiffFetcher,
  logger?: (msg: string) => void,
): Promise<ContextChunk[]> {
  const setting = cfg.get<boolean>(CFG.useGitDiff, true);
  const forced = overrides?.diff === true;
  const forcedOff = overrides?.diff === false;
  if (forcedOff) return [];
  if (!setting && !forced) return [];

  const raw = await diffFetcher(document);
  if (!raw || !raw.trim()) return [];

  const { text, hunkCount } = stripDiff(raw);
  if (!text.trim()) return [];

  const capped = capDiff(text, DIFF_CAP);
  logger?.(`git-diff (chars=${capped.length}, hunks=${hunkCount})`);

  return [
    {
      source: "diff",
      label: "pending changes",
      language: "diff",
      text: capped,
    },
  ];
}
