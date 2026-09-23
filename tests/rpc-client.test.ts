/**
 * Regression tests for the Pi RPC channel client
 * Covers LF-only framing, request correlation, timeout, and close semantics
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramRpcClient,
  splitTelegramRpcFrames,
} from "../lib/rpc-client.ts";

test("RPC framing splits only on LF and tolerates CRLF", () => {
  const batch = splitTelegramRpcFrames('{"a":1}\r\n{"b":"x\u2028y"}\n{"c":');
  assert.deepEqual(batch.frames, ['{"a":1}', '{"b":"x\u2028y"}']);
  assert.equal(batch.rest, '{"c":');
});

test("RPC framing drops empty frames and keeps the trailing remainder", () => {
  assert.deepEqual(splitTelegramRpcFrames("\n\n"), { frames: [], rest: "" });
  assert.deepEqual(splitTelegramRpcFrames("partial"), {
    frames: [],
    rest: "partial",
  });
});

test("RPC client correlates a response by request id", async () => {
  const written: string[] = [];
  const client = createTelegramRpcClient({
    write: (line) => written.push(line),
    newRequestId: () => "req-1",
  });
  const pending = client.request({ type: "get_state" });
  assert.equal(client.pendingCount(), 1);
  assert.deepEqual(JSON.parse(written[0] ?? "{}"), {
    type: "get_state",
    id: "req-1",
  });
  assert.equal(
    client.handleFrame(
      JSON.stringify({
        id: "req-1",
        type: "response",
        command: "get_state",
        success: true,
        data: { isStreaming: false },
      }),
    ),
    true,
  );
  const response = await pending;
  assert.equal(response.success, true);
  assert.equal(client.pendingCount(), 0);
});

test("RPC client forwards events and rejects unmatched frame ids", () => {
  const events: unknown[] = [];
  const errors: Error[] = [];
  const client = createTelegramRpcClient({
    write: () => undefined,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    newRequestId: () => "req-1",
  });
  assert.equal(
    client.handleFrame(JSON.stringify({ type: "agent_start" })),
    false,
  );
  assert.deepEqual(events, [{ type: "agent_start" }]);
  assert.equal(
    client.handleFrame(
      JSON.stringify({ id: "other", type: "response", command: "x", success: true }),
    ),
    false,
  );
  assert.equal(client.handleFrame("not-json"), false);
  assert.equal(errors.length, 1);
});

test("RPC client rejects a pending request on timeout", async () => {
  const timers: Array<() => void> = [];
  const client = createTelegramRpcClient({
    write: () => undefined,
    setTimer: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimer: () => undefined,
    newRequestId: () => "req-1",
    defaultTimeoutMs: 5,
  });
  const pending = client.request({ type: "prompt" });
  assert.equal(timers.length, 1);
  timers[0]?.();
  await assert.rejects(pending, /timed out/u);
  assert.equal(client.pendingCount(), 0);
});

test("RPC client rejects every pending request when closed", async () => {
  const client = createTelegramRpcClient({
    write: () => undefined,
    newRequestId: () => "req-1",
  });
  const pending = client.request({ type: "abort" });
  client.close("worker stopped");
  await assert.rejects(pending, /worker stopped/u);
  await assert.rejects(client.request({ type: "prompt" }), /closed/u);
});
