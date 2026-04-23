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

export class Uri {
  constructor(public readonly scheme: string, public readonly fsPath: string) {}
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
  static parse(s: string): Uri {
    const m = /^([a-z-]+):\/\/(.*)$/.exec(s);
    if (m) return new Uri(m[1], m[2]);
    return new Uri("file", s);
  }
  static file(p: string): Uri {
    return new Uri("file", p);
  }
}

export class FakeTextDocument {
  public readonly lines: string[];
  public readonly uri: Uri;
  constructor(
    public readonly languageId: string,
    public readonly fileName: string,
    content: string,
  ) {
    this.lines = content.split("\n");
    this.uri = new Uri("file", fileName);
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
export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T): T => fallback,
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  }),
  openTextDocument: async (_uri: Uri): Promise<FakeTextDocument> => {
    throw new Error("openTextDocument stub — inject a fake in your test");
  },
  onDidChangeTextDocument: (_listener: unknown) => ({ dispose: () => undefined }),
};
export const window = {
  visibleTextEditors: [] as unknown[],
};
export const languages = {};
export const commands = {
  executeCommand: async <T>(_cmd: string, ..._args: unknown[]): Promise<T> => {
    throw new Error("executeCommand stub — inject a runner in your test");
  },
};
export const extensions = {
  getExtension: (_id: string) => null,
};
export const InlineCompletionTriggerKind = { Invoke: 0, Automatic: 1 };

export class StatusBarAlignment {}
export class ThemeColor {
  constructor(public id: string) {}
}
