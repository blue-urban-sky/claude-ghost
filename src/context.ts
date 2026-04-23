import * as vscode from "vscode";
import type { ProviderOverrides } from "./provider";
import { CFG } from "./state";
import { collectVisibleRecent } from "./context/visibleRecent";
import { collectSymbols } from "./context/symbols";
import { collectGitDiff } from "./context/gitDiff";
import { collectHover } from "./context/hover";

// A single extra-context contribution that will be rendered BEFORE the
// current file envelope in the completion prompt. Populated by the four
// Wave-2 providers: visible/recent editors, LSP symbol resolution, git
// diff, and receiver hover.
export type ContextChunk = {
  source: string;
  label: string;
  language?: string;
  text: string;
};

// Assemble extra context chunks for a completion request. Providers run
// in priority order (smallest / highest-signal first). Each provider's
// own override logic decides if it fires; the orchestrator only enforces
// the total byte budget (extraContextMaxBytes) across the combined chunks,
// trimming lowest-priority items from the tail if the cap is breached.
export async function assembleExtraContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  cfg: vscode.WorkspaceConfiguration,
  overrides: ProviderOverrides | null,
  logger?: (msg: string) => void,
): Promise<ContextChunk[]> {
  const budget = cfg.get<number>(CFG.extraContextMaxBytes, 30000);

  // Priority order: diff, symbols, hover first (tiny, high-signal); then
  // visible/recent (widest net, default off).
  const diff = await collectGitDiff(document, position, cfg, overrides, undefined, logger);
  const symbolsSkipUris = new Set<string>();

  const symbols = await collectSymbols(
    document,
    position,
    cfg,
    overrides,
    symbolsSkipUris,
    undefined,
    undefined,
    logger,
  );
  const hover = await collectHover(document, position, cfg, overrides, undefined, logger);

  // Visible/recent runs last and with symbols' files already in the skip list
  // would be ideal — but visible/recent is the lowest-priority source, so we
  // let it run freely and rely on the byte-budget trimmer to drop duplicates
  // at the bottom. In practice collisions are rare.
  const visibleRecent = await collectVisibleRecent(
    document,
    position,
    cfg,
    overrides,
    undefined,
    logger,
  );

  // Concatenate in render order: diff, symbols, hover, visible/recent.
  // When trimming we drop from the tail (visibleRecent is lowest priority).
  const combined: ContextChunk[] = [...diff, ...symbols, ...hover, ...visibleRecent];
  const sizeOf = (arr: ContextChunk[]): number =>
    arr.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
  while (combined.length > 0 && sizeOf(combined) > budget) {
    combined.pop();
  }

  const group = (tag: string): number =>
    combined
      .filter((c) => c.source === tag)
      .reduce((n, c) => n + c.text.length, 0);
  const diffLen = group("diff");
  const symbolsLen = group("symbols");
  const hoverLen = group("hover");
  const visibleLen = group("visible");
  const recentLen = group("recent");
  const total = diffLen + symbolsLen + hoverLen + visibleLen + recentLen;
  const k = (n: number): string => `${Math.round(n / 100) / 10}k`;
  logger?.(
    `extra context assembled: {diff=${k(diffLen)}, symbols=${k(symbolsLen)}, hover=${k(hoverLen)}, visible=${k(visibleLen)}, recent=${k(recentLen)}} total=${k(total)}/${k(budget)}`,
  );

  return combined;
}
