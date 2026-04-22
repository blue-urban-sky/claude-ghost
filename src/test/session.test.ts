import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  isCliMessage,
  isControlResponse,
  isStreamEvent,
  isResult,
  isTextDelta,
  type StreamEvent,
} from "../session";

test("isCliMessage rejects non-objects", () => {
  assert.equal(isCliMessage(null), false);
  assert.equal(isCliMessage("str"), false);
  assert.equal(isCliMessage(42), false);
  assert.equal(isCliMessage({}), false);
});

test("isCliMessage accepts object with string type", () => {
  assert.equal(isCliMessage({ type: "result" }), true);
});

test("isControlResponse narrows", () => {
  const m: unknown = { type: "control_response", response: { request_id: "x", subtype: "success" } };
  assert.equal(isCliMessage(m), true);
  if (!isCliMessage(m)) throw new Error("unreachable");
  assert.equal(isControlResponse(m), true);
});

test("isStreamEvent narrows", () => {
  const m: unknown = { type: "stream_event", event: { type: "message_start" } };
  assert.equal(isCliMessage(m), true);
  if (!isCliMessage(m)) throw new Error("unreachable");
  assert.equal(isStreamEvent(m), true);
});

test("isResult narrows", () => {
  const m: unknown = { type: "result" };
  assert.equal(isCliMessage(m), true);
  if (!isCliMessage(m)) throw new Error("unreachable");
  assert.equal(isResult(m), true);
});

test("isTextDelta: valid content_block_delta with text_delta", () => {
  const evt: StreamEvent = { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } };
  assert.equal(isTextDelta(evt), true);
});

test("isTextDelta rejects non-text deltas", () => {
  const evt: StreamEvent = { type: "content_block_delta", delta: { type: "input_json_delta" } };
  assert.equal(isTextDelta(evt), false);
});

test("isTextDelta rejects undefined", () => {
  assert.equal(isTextDelta(undefined), false);
});
