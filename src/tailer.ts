import * as fs from "node:fs";

export type LineHandler = (line: string) => void;
export type TailerLogger = (msg: string) => void;

const BUFFER_CAP_BYTES = 8 * 1024 * 1024;

// Simple file tailer: polls for size growth and emits complete newline-terminated
// lines to the handler. Starts from end-of-file by default.
export class JsonlTailer {
  private fd: number | null = null;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private buffer = "";
  private resyncing = false;

  constructor(
    private readonly filePath: string,
    private readonly onLine: LineHandler,
    private readonly fromStart = true,
    private readonly log: TailerLogger = () => undefined,
  ) {}

  start(): boolean {
    try {
      // Reject symlinks and non-regular files to avoid opening a FIFO, device,
      // etc. by accident.
      const lst = fs.lstatSync(this.filePath);
      if (lst.isSymbolicLink()) {
        this.log(`tailer: refusing symlink at ${this.filePath}`);
        return false;
      }
      if (!lst.isFile()) {
        this.log(`tailer: refusing non-regular file at ${this.filePath}`);
        return false;
      }
      this.fd = fs.openSync(this.filePath, "r");
      this.offset = this.fromStart ? 0 : fs.fstatSync(this.fd).size;
    } catch (err) {
      this.log(`tailer: failed to open ${this.filePath}: ${errMsg(err)}`);
      return false;
    }
    // Immediate read so existing content appears without waiting for a poll.
    this.poll();
    this.timer = setInterval(() => this.poll(), 500);
    return true;
  }

  private poll(): void {
    if (this.fd === null) return;
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size <= this.offset) {
        if (stat.size < this.offset) this.offset = stat.size;
        return;
      }
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(this.fd, buf, 0, len, this.offset);
      this.offset = stat.size;
      this.buffer += buf.toString("utf8");
      if (Buffer.byteLength(this.buffer, "utf8") > BUFFER_CAP_BYTES) {
        this.log(
          `tailer: buffer exceeded ${BUFFER_CAP_BYTES} bytes — resyncing on next \\n`,
        );
        this.buffer = "";
        this.resyncing = true;
      }
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (this.resyncing) {
          // Drop the first (possibly partial) line after an overflow; resume
          // delivering from the next newline onward.
          this.resyncing = false;
          continue;
        }
        if (line.trim()) this.onLine(line);
      }
    } catch (err) {
      this.log(`tailer: poll error: ${errMsg(err)}`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = null;
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  thinking?: string;
}

export function formatJsonlLine(line: string): string | null {
  let msg: { type?: string; subtype?: string; message?: { content?: unknown }; [k: string]: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  const t = msg.type;
  if (t === "user") {
    const raw = extractText(msg.message?.content);
    const condensed = condenseCompletionRequest(raw);
    return `\n── USER ──\n${condensed ?? raw}`;
  }
  if (t === "assistant") {
    return `\n── ASSISTANT ──\n${extractText(msg.message?.content)}`;
  }
  if (t === "system") {
    return `── system/${msg.subtype ?? "?"} ──`;
  }
  if (t === "summary") {
    return `── summary ──`;
  }
  return null;
}

// Our USER messages to Claude look like:
//   <hint>…</hint>            (optional)
//   <file name="…" language="…">
//   {prefix}«CURSOR»{suffix}
//   </file>
// The pretty log trims this to: any <hint>, the <file …> tag, and just the
// cursor line (or the line above if the cursor line is empty).
function condenseCompletionRequest(text: string): string | null {
  if (!text.includes("«CURSOR»")) return null;
  const lines = text.split("\n");
  const cursorIdx = lines.findIndex((l) => l.includes("«CURSOR»"));
  if (cursorIdx === -1) return null;

  const out: string[] = [];
  for (const l of lines) {
    if (/^<hint(?:-[a-f0-9]+)?>/.test(l)) out.push(l);
  }
  const fileLine = lines.find((l) => /^<file(?:-[a-f0-9]+)?\s/.test(l));
  if (fileLine) out.push(fileLine);

  const cursorLine = lines[cursorIdx];
  const withoutMarker = cursorLine.replace("«CURSOR»", "");
  if (withoutMarker.trim() === "" && cursorIdx > 0) {
    out.push(lines[cursorIdx - 1]);
  } else {
    out.push(cursorLine);
  }
  return out.join("\n");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((block) => {
        if (block.type === "text") return block.text ?? "";
        if (block.type === "thinking") {
          const preview = (block.thinking ?? "").slice(0, 80);
          return `[thinking: ${preview}${(block.thinking ?? "").length > 80 ? "…" : ""}]`;
        }
        if (block.type === "tool_use") return `[tool_use: ${block.name ?? "?"}]`;
        if (block.type === "tool_result") return `[tool_result]`;
        return `[${block.type ?? "?"}]`;
      })
      .join("");
  }
  return JSON.stringify(content);
}
