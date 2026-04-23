import * as vscode from "vscode";

// Braille spinner frames. Eight frames cycling at ~100 ms per frame feels
// organic — fast enough to read as "working", slow enough not to flicker.
// Matches the familiar CLI spinner used by npm, yarn, etc.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 100;

export interface ProgressIndicator {
  stop(): void;
}

export function startProgressIndicator(
  editor: vscode.TextEditor,
  line: number,
): ProgressIndicator {
  const types = FRAMES.map((frame) =>
    vscode.window.createTextEditorDecorationType({
      after: {
        contentText: `  ${frame}`,
        color: "#808080",
        fontStyle: "italic",
      },
    }),
  );

  let frame = 0;
  let stopped = false;

  const apply = (): void => {
    if (stopped) return;
    const doc = editor.document;
    if (line >= doc.lineCount) return;
    const lineEnd = doc.lineAt(line).range.end;
    const range = new vscode.Range(lineEnd, lineEnd);
    // VS Code decorates one type per call; clear the others by setting [].
    for (let i = 0; i < types.length; i++) {
      editor.setDecorations(types[i], i === frame ? [range] : []);
    }
    frame = (frame + 1) % types.length;
  };

  apply();
  const interval = setInterval(apply, FRAME_MS);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      for (const t of types) {
        try {
          editor.setDecorations(t, []);
        } catch {
          // editor might be disposed; ignore
        }
        t.dispose();
      }
    },
  };
}
