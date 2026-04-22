// Minimal runtime stub for the `vscode` module so pure tests can import
// modules that reference `vscode.Position` / `vscode.TextDocument`.

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export interface TextLineShim {
  text: string;
  range: Range;
}

export class FakeTextDocument {
  public readonly lines: string[];
  constructor(
    public readonly languageId: string,
    public readonly fileName: string,
    content: string,
  ) {
    this.lines = content.split("\n");
  }
  get lineCount(): number {
    return this.lines.length;
  }
  getText(): string {
    return this.lines.join("\n");
  }
  lineAt(line: number): TextLineShim {
    const text = this.lines[line] ?? "";
    return {
      text,
      range: new Range(new Position(line, 0), new Position(line, text.length)),
    };
  }
  offsetAt(pos: Position): number {
    let offset = 0;
    for (let i = 0; i < pos.line; i++) {
      offset += (this.lines[i]?.length ?? 0) + 1;
    }
    return offset + pos.character;
  }
}

// Matches the shape consumed by createRequire() fallbacks below.
export const workspace = {};
export const window = {};
export const languages = {};
export const commands = {};
export const InlineCompletionTriggerKind = { Invoke: 0, Automatic: 1 };

export class StatusBarAlignment {}
export class ThemeColor {
  constructor(public id: string) {}
}
