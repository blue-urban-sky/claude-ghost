import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  isCliMessage,
  isControlResponse,
  isStreamEvent,
  isResult,
  isTextDelta,
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
  const m = { type: "control_response", response: { request_id: "x", subtype: "success" } };
  assert.equal(isCliMessage(m), true);
  assert.equal(isControlResponse(m as any), true);
});

test("isStreamEvent narrows", () => {
  const m = { type: "stream_event", event: { type: "message_start" } };
  assert.equal(isStreamEvent(m as any), true);
});

test("isResult narrows", () => {
  const m = { type: "result" };
  assert.equal(isResult(m as any), true);
});

test("isTextDelta: valid content_block_delta with text_delta", () => {
  const evt = { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } };
  assert.equal(isTextDelta(evt as any), true);
});

test("isTextDelta rejects non-text deltas", () => {
  const evt = { type: "content_block_delta", delta: { type: "input_json_delta" } };
  assert.equal(isTextDelta(evt as any), false);
});

test("isTextDelta rejects undefined", () => {
  assert.equal(isTextDelta(undefined), false);
});
