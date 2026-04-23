import * as vscode from "vscode";

// A single extra-context contribution that will be rendered BEFORE the
// current file envelope in the completion prompt. Wave 2 populates this
// with data pulled from visible editors, recent edits, symbol resolution,
// git diff, etc. For now the builder is a stub so the provider/prompt
// seam is in place without any behaviour change.
export type ContextChunk = {
  source: string;
  label: string;
  language?: string;
  text: string;
};

// Assemble extra context chunks for a completion request. Currently a
// stub that returns []; kept as a free function (not a class) so Wave 2
// providers can be added without API churn on the caller side.
export function assembleExtraContext(
  _document: vscode.TextDocument,
  _position: vscode.Position,
  _cfg: vscode.WorkspaceConfiguration,
): ContextChunk[] {
  return [];
}
