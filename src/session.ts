import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeSessionOptions {
  model?: string;
  systemPrompt?: string;
  cwd?: string;
  claudePath?: string;
  // --bare requires ANTHROPIC_API_KEY or apiKeyHelper; default false so OAuth-only
  // installs work.
  bare?: boolean;
  // --effort: low|medium|high|xhigh|max. Only reduces thinking budget;
  // does NOT disable thinking. Use disableThinking for that.
  effort?: EffortLevel;
  // Sets CLAUDE_CODE_DISABLE_THINKING=1 on the child process, overriding the
  // global settings.json `alwaysThinkingEnabled`. Essential for inline
  // completion latency.
  disableThinking?: boolean;
}

export type SessionState =
  | "idle"
  | "starting"
  | "ready"
  | "generating"
  | "error"
  | "stopped";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// Limits
const INIT_HANDSHAKE_TIMEOUT_MS = 10_000;
const CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const STOP_SIGTERM_TIMEOUT_MS = 3_000;
const STOP_HARD_TIMEOUT_MS = 5_000;
const COMPLETION_QUEUE_MAX_BYTES = 10 * 1024 * 1024;

// Discriminated union describing the CLI's stream-json output.
export type StreamEvent =
  | { type: "content_block_delta"; delta?: { type?: string; text?: string } }
  | {
      type:
        | "message_start"
        | "message_delta"
        | "message_stop"
        | "content_block_start"
        | "content_block_stop"
        | (string & {});
      [k: string]: unknown;
    };

export type CliMessage =
  | {
      type: "control_response";
      response: {
        request_id: string;
        subtype: "success" | "error";
        error?: string;
        [k: string]: unknown;
      };
    }
  | { type: "stream_event"; event: StreamEvent }
  | { type: "result"; subtype?: string; error?: unknown; [k: string]: unknown }
  | { type: "system"; subtype?: string; [k: string]: unknown }
  | { type: "user" | "assistant"; message?: unknown; [k: string]: unknown };

export function isCliMessage(m: unknown): m is CliMessage {
  if (!m || typeof m !== "object") return false;
  const t = (m as { type?: unknown }).type;
  return typeof t === "string";
}

export function isControlResponse(
  m: CliMessage,
): m is Extract<CliMessage, { type: "control_response" }> {
  return m.type === "control_response";
}

export function isStreamEvent(
  m: CliMessage,
): m is Extract<CliMessage, { type: "stream_event" }> {
  return m.type === "stream_event";
}

export function isResult(
  m: CliMessage,
): m is Extract<CliMessage, { type: "result" }> {
  return m.type === "result";
}

type ContentBlockDelta = Extract<StreamEvent, { type: "content_block_delta" }>;

function isContentBlockDelta(evt: StreamEvent): evt is ContentBlockDelta {
  return evt.type === "content_block_delta";
}

export function isTextDelta(
  evt: StreamEvent | undefined,
): evt is ContentBlockDelta & { delta: { type: "text_delta"; text: string } } {
  if (!evt || !isContentBlockDelta(evt)) return false;
  const { delta } = evt;
  return !!delta && delta.type === "text_delta" && typeof delta.text === "string";
}

interface PendingCompletion {
  push: (chunk: string) => void;
  end: () => void;
  fail: (err: Error) => void;
  interrupted: boolean;
}

interface PendingControl {
  requestId: string;
  resolve: (resp: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class ClaudeSession {
  #sessionId: string;
  private _state: SessionState = "idle";
  private readonly emitter = new EventEmitter();
  private readonly opts: ClaudeSessionOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private stderrBuf: string[] = [];
  private pending: PendingCompletion | null = null;
  private pendingControls = new Map<string, PendingControl>();
  private exitResolvers: Array<() => void> = [];
  private lastError: Error | null = null;
  private lifecycleInFlight: Promise<void> | null = null;

  constructor(opts: ClaudeSessionOptions = {}) {
    this.#sessionId = randomUUID();
    this.opts = opts;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get state(): SessionState {
    return this._state;
  }

  on(event: "state", listener: (s: SessionState) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "stderr", listener: (chunk: string) => void): void;
  on(event: "stdout-line", listener: (msg: CliMessage) => void): void;
  on(event: string, listener: (...args: never) => void): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off(event: string, listener: (...args: never) => void): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private setState(s: SessionState): void {
    if (this._state === s) return;
    this._state = s;
    this.emitter.emit("state", s);
  }

  private emitError(err: Error): void {
    this.lastError = err;
    if (this.emitter.listenerCount("error") > 0) {
      this.emitter.emit("error", err);
    }
  }

  async start(): Promise<void> {
    if (this._state !== "idle" && this._state !== "stopped") {
      throw new Error(`cannot start from state ${this._state}`);
    }
    this.setState("starting");
    this.stderrBuf = [];
    this.lastError = null;

    const bin = this.opts.claudePath ?? "claude";
    const rawModel = this.opts.model ?? DEFAULT_MODEL;
    // Argument-injection guard: reject model values starting with `-` so a
    // crafted setting can't smuggle in a flag.
    if (rawModel.startsWith("-")) {
      const err = new Error(`invalid model value (starts with '-'): ${rawModel}`);
      this.setState("error");
      this.emitError(err);
      throw err;
    }
    const model = rawModel;
    const args: string[] = ["-p"];
    if (this.opts.bare) {
      args.push("--bare");
    }
    // CLI flag order matters: `--tools ""` first so argv parsing can't reorder
    // around `--model=...` (we use the `=` form to defend against `-`-prefixed
    // values being parsed as a new flag).
    args.push(
      "--tools",
      "",
      "--strict-mcp-config",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      `--model=${model}`,
      "--session-id",
      this.#sessionId,
    );
    if (this.opts.effort) {
      args.push("--effort", this.opts.effort);
    }
    if (this.opts.systemPrompt !== undefined) {
      args.push("--system-prompt", this.opts.systemPrompt);
    }

    const env = { ...process.env };
    if (this.opts.disableThinking) {
      env.CLAUDE_CODE_DISABLE_THINKING = "1";
    }
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    };
    if (this.opts.cwd) {
      spawnOpts.cwd = this.opts.cwd;
    }
    const child = spawn(bin, args, spawnOpts) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuf.push(chunk);
      const joined = this.stderrBuf.join("");
      if (joined.length > 64 * 1024) {
        this.stderrBuf = [joined.slice(-32 * 1024)];
      }
      this.emitter.emit("stderr", chunk);
    });

    child.on("error", (err) => {
      this.handleFatal(err);
    });

    child.stdin.on("error", (err) => {
      // Async stream errors (EPIPE, etc.) must route through handleFatal;
      // sync try/catch around write() can't see them.
      this.handleFatal(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });

    const rl = createInterface({ input: child.stdout });
    this.rl = rl;
    rl.on("line", (line) => this.onLine(line));

    // The CLI emits no output until it receives input. Send a control_request
    // initialize handshake; resolve start() on the matching control_response.
    const initId = randomUUID();
    const initPayload = JSON.stringify({
      type: "control_request",
      request_id: initId,
      request: { subtype: "initialize" },
    });
    const initPromise = this.registerPendingControl(
      initId,
      INIT_HANDSHAKE_TIMEOUT_MS,
      "initialize handshake timed out",
    );
    try {
      child.stdin.write(initPayload + "\n");
    } catch (err) {
      const pc = this.pendingControls.get(initId);
      if (pc?.timer) clearTimeout(pc.timer);
      this.pendingControls.delete(initId);
      const e = err instanceof Error ? err : new Error(String(err));
      this.handleFatal(e);
      throw e;
    }
    try {
      await initPromise;
    } catch (err) {
      this.handleFatal(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    this.setState("ready");
  }

  private registerPendingControl(
    requestId: string,
    timeoutMs: number,
    timeoutMsg: string,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pc = this.pendingControls.get(requestId);
        if (!pc) return;
        this.pendingControls.delete(requestId);
        reject(new Error(timeoutMsg));
      }, timeoutMs);
      this.pendingControls.set(requestId, {
        requestId,
        resolve: (resp) => {
          if (timer) clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
        timer,
      });
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isCliMessage(parsed)) return;
    const msg = parsed;
    this.emitter.emit("stdout-line", msg);

    if (isControlResponse(msg)) {
      const resp = msg.response;
      const reqId = typeof resp?.request_id === "string" ? resp.request_id : undefined;
      if (!reqId) return;
      const pc = this.pendingControls.get(reqId);
      if (!pc) return;
      this.pendingControls.delete(reqId);
      if (pc.timer) clearTimeout(pc.timer);
      if (resp.subtype === "success") {
        pc.resolve(resp as Record<string, unknown>);
      } else {
        pc.reject(new Error(`control_request failed: ${JSON.stringify(resp)}`));
      }
      return;
    }

    if (isStreamEvent(msg)) {
      if (isTextDelta(msg.event)) {
        if (this.pending) {
          this.pending.push(msg.event.delta.text);
        }
      }
      return;
    }

    if (isResult(msg)) {
      const p = this.pending;
      this.pending = null;
      const wasInterrupted = p?.interrupted === true;
      if (this._state === "generating") {
        this.setState("ready");
      }
      if (!p) return;
      if (msg.subtype === "error_during_execution" && !wasInterrupted) {
        const err = new Error(
          `claude result error: ${msg.error ?? msg.subtype ?? "unknown"}`,
        );
        p.fail(err);
      } else {
        p.end();
      }
      return;
    }
    // system / user / assistant / unknown: drop.
  }

  private handleFatal(err: Error): void {
    this.lastError = err;
    this.setState("error");
    this.emitError(err);
    for (const pc of this.pendingControls.values()) {
      if (pc.timer) clearTimeout(pc.timer);
      pc.reject(err);
    }
    this.pendingControls.clear();
    if (this.pending) {
      this.pending.fail(err);
      this.pending = null;
    }
    // Spawn errors (ENOENT) never emit `exit`; drain exitResolvers so stop()
    // can never hang forever waiting for an exit that won't come.
    for (const r of this.exitResolvers) r();
    this.exitResolvers = [];
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const stderr = this.stderrBuf.join("");
    const isClean = this._state === "stopped" || (code === 0 && signal === null);

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.child = null;

    if (!isClean && this._state !== "error") {
      const err = new Error(
        `claude exited unexpectedly (code=${code}, signal=${signal}): ${stderr.slice(-2000)}`,
      );
      this.lastError = err;
      this.setState("error");
      this.emitError(err);
      for (const pc of this.pendingControls.values()) {
        if (pc.timer) clearTimeout(pc.timer);
        pc.reject(err);
      }
      this.pendingControls.clear();
      if (this.pending) {
        this.pending.fail(err);
        this.pending = null;
      }
    } else {
      if (this.pending) {
        this.pending.end();
        this.pending = null;
      }
      for (const pc of this.pendingControls.values()) {
        if (pc.timer) clearTimeout(pc.timer);
        pc.resolve({});
      }
      this.pendingControls.clear();
      if (this._state !== "error") {
        this.setState("stopped");
      }
    }

    for (const r of this.exitResolvers) r();
    this.exitResolvers = [];
  }

  complete(prompt: string): AsyncIterable<string> {
    if (this._state !== "ready") {
      throw new Error(`cannot complete from state ${this._state}`);
    }
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("child process not writable");
    }

    type QueueItem =
      | { kind: "chunk"; chunk: string }
      | { kind: "done" }
      | { kind: "err"; err: Error };

    const queue: QueueItem[] = [];
    let queueBytes = 0;
    let waiter: ((v: IteratorResult<string>) => void) | null = null;
    let waiterReject: ((err: Error) => void) | null = null;
    let overflowed = false;

    const failOverflow = (): Error => {
      overflowed = true;
      const err = new Error(
        `completion queue exceeded ${COMPLETION_QUEUE_MAX_BYTES} bytes`,
      );
      queue.length = 0;
      return err;
    };

    const pending: PendingCompletion = {
      push: (chunk: string) => {
        if (overflowed) return;
        if (waiter) {
          const w = waiter;
          waiter = null;
          waiterReject = null;
          w({ value: chunk, done: false });
          return;
        }
        queueBytes += Buffer.byteLength(chunk, "utf8");
        if (queueBytes > COMPLETION_QUEUE_MAX_BYTES) {
          const err = failOverflow();
          queue.push({ kind: "err", err });
          return;
        }
        queue.push({ kind: "chunk", chunk });
      },
      end: () => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          waiterReject = null;
          w({ value: undefined, done: true });
        } else {
          queue.push({ kind: "done" });
        }
      },
      fail: (err: Error) => {
        if (waiterReject) {
          const wr = waiterReject;
          waiter = null;
          waiterReject = null;
          wr(err);
        } else {
          queue.push({ kind: "err", err });
        }
      },
      interrupted: false,
    };

    this.pending = pending;
    this.setState("generating");

    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });
    try {
      this.child.stdin.write(payload + "\n");
    } catch (err) {
      this.pending = null;
      this.setState("ready");
      throw err instanceof Error ? err : new Error(String(err));
    }

    const iter: AsyncIterator<string> = {
      next: (): Promise<IteratorResult<string>> => {
        const item = queue.shift();
        if (item) {
          switch (item.kind) {
            case "err":
              return Promise.reject(item.err);
            case "done":
              return Promise.resolve({ value: undefined, done: true });
            case "chunk":
              queueBytes -= Buffer.byteLength(item.chunk, "utf8");
              return Promise.resolve({ value: item.chunk, done: false });
          }
        }
        return new Promise((resolve, reject) => {
          waiter = resolve;
          waiterReject = reject;
        });
      },
      return: (): Promise<IteratorResult<string>> => {
        return Promise.resolve({ value: undefined, done: true });
      },
    };

    return {
      [Symbol.asyncIterator]() {
        return iter;
      },
    };
  }

  async interrupt(): Promise<void> {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("child process not writable");
    }
    if (this._state !== "generating") {
      return;
    }
    if (this.pending) {
      this.pending.interrupted = true;
    }
    const requestId = randomUUID();
    const payload = JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    });
    // Timeout prevents a leaked entry if the CLI raced state generating→ready
    // and the control_response never comes.
    const p = this.registerPendingControl(
      requestId,
      CONTROL_REQUEST_TIMEOUT_MS,
      "interrupt control_request timed out",
    );
    try {
      this.child.stdin.write(payload + "\n");
    } catch (err) {
      const pc = this.pendingControls.get(requestId);
      if (pc?.timer) clearTimeout(pc.timer);
      this.pendingControls.delete(requestId);
      throw err instanceof Error ? err : new Error(String(err));
    }
    try {
      await p;
    } catch {
      // Swallow interrupt-timeout: the CLI already transitioned out of
      // generating in the common race; the overall completion will unwind
      // via its own channels.
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycleInFlight) return this.lifecycleInFlight;
    this.lifecycleInFlight = this.doStop().finally(() => {
      this.lifecycleInFlight = null;
    });
    return this.lifecycleInFlight;
  }

  private async doStop(): Promise<void> {
    if (!this.child) {
      if (this._state !== "error") this.setState("stopped");
      return;
    }
    this.setState("stopped");
    const childRef = this.child;
    const waitExit = new Promise<void>((resolve) => {
      this.exitResolvers.push(resolve);
    });
    try {
      if (childRef.stdin.writable) {
        childRef.stdin.end();
      }
    } catch {
      // ignore
    }
    const sigterm = setTimeout(() => {
      try {
        childRef.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, STOP_SIGTERM_TIMEOUT_MS);
    const sigkill = setTimeout(() => {
      try {
        childRef.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, STOP_SIGTERM_TIMEOUT_MS + 1_500);
    const hard = new Promise<void>((resolve) =>
      setTimeout(resolve, STOP_HARD_TIMEOUT_MS),
    );
    try {
      await Promise.race([waitExit, hard]);
    } finally {
      clearTimeout(sigterm);
      clearTimeout(sigkill);
    }
  }

  async restart(): Promise<void> {
    if (this.lifecycleInFlight) {
      await this.lifecycleInFlight;
    }
    this.lifecycleInFlight = this.doRestart().finally(() => {
      this.lifecycleInFlight = null;
    });
    return this.lifecycleInFlight;
  }

  private async doRestart(): Promise<void> {
    // Clear pending completion before stopping so callers don't hang on a
    // completion that can never land.
    if (this.pending) {
      this.pending.fail(new Error("session restarted"));
      this.pending = null;
    }
    await this.doStop();
    this.#sessionId = randomUUID();
    this._state = "idle";
    this.stderrBuf = [];
    this.lastError = null;
    await this.start();
  }
}
