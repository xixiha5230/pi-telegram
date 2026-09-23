/**
 * Regression tests for the managed Pi worker RPC host
 * Covers state projection, event reduction, and command dispatch
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  countTelegramRpcWorkerPending,
  createTelegramRpcWorkerHost,
  createTelegramRpcWorkerState,
  isTelegramRpcWorkerBusy,
  parseTelegramRpcWorkerState,
  reduceTelegramRpcWorkerState,
} from "../lib/rpc-host.ts";

const NOW = 1_790_000_000_000;

test("Worker state projects a get_state payload", () => {
  const state = parseTelegramRpcWorkerState({
    model: { id: "deepseek-v4.1-flash", provider: "ada" },
    thinkingLevel: "medium",
    isStreaming: true,
    isCompacting: false,
    sessionId: "01a0c931",
    sessionName: "plugins",
  }, NOW);
  assert.equal(state.model, "ada/deepseek-v4.1-flash");
  assert.equal(state.thinkingLevel, "medium");
  assert.equal(state.sessionId, "01a0c931");
  assert.equal(state.sessionName, "plugins");
  assert.equal(state.isStreaming, true);
  assert.equal(isTelegramRpcWorkerBusy(state), true);
  const empty = parseTelegramRpcWorkerState(undefined, NOW);
  assert.equal(empty.model, undefined);
  assert.equal(empty.isStreaming, false);
});

test("Worker events reduce only transitions", () => {
  let state = createTelegramRpcWorkerState(NOW);
  state = reduceTelegramRpcWorkerState(state, { type: "agent_start" }, NOW + 1);
  assert.equal(state.isStreaming, true);
  state = reduceTelegramRpcWorkerState(state, { type: "queue_update", steering: ["a"], followUp: ["b", "c"] }, NOW + 2);
  assert.equal(countTelegramRpcWorkerPending(state), 3);
  state = reduceTelegramRpcWorkerState(state, { type: "compaction_start" }, NOW + 3);
  assert.equal(state.isCompacting, true);
  const settled = reduceTelegramRpcWorkerState(state, { type: "agent_settled" }, NOW + 4);
  assert.equal(settled.isStreaming, false);
  assert.equal(settled.isCompacting, false);
  assert.equal(countTelegramRpcWorkerPending(settled), 3);
  // Token deltas and unknown events never move the projection.
  assert.equal(reduceTelegramRpcWorkerState(settled, { type: "message_update", delta: "x" }, NOW + 5), settled);
  assert.equal(reduceTelegramRpcWorkerState(settled, "nonsense", NOW + 6), settled);
  // A repeated transition is inert so title writers stay debounced.
  const streaming = reduceTelegramRpcWorkerState(settled, { type: "agent_start" }, NOW + 7);
  assert.equal(reduceTelegramRpcWorkerState(streaming, { type: "agent_start" }, NOW + 8), streaming);
});

test("Worker host dispatches commands and reports failures", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const host = createTelegramRpcWorkerHost({
    now: () => NOW,
    request: async (command) => {
      sent.push(command);
      return { type: "response", command: command.type, success: command.type !== "abort" };
    },
  });
  assert.equal(await host.prompt("hello"), true);
  assert.equal(await host.prompt("more", { streamingBehavior: "steer" }), true);
  assert.equal(await host.steer("stop"), true);
  assert.equal(await host.setModel("ada", "deepseek-v4.1-flash"), true);
  assert.equal(await host.setThinkingLevel("high"), true);
  assert.equal(await host.abort(), false);
  assert.deepEqual(sent.map((command) => command.type), [
    "prompt", "prompt", "steer", "set_model", "set_thinking_level", "abort",
  ]);
  assert.equal(sent[1]?.streamingBehavior, "steer");
  assert.equal(sent[3]?.provider, "ada");
  assert.equal(sent[3]?.modelId, "deepseek-v4.1-flash");
  assert.equal(sent[4]?.level, "high");
});

test("Worker host publishes state transitions to subscribers once per change", async () => {
  const host = createTelegramRpcWorkerHost({
    now: () => NOW,
    request: async (command) => ({
      type: "response",
      command: command.type,
      success: true,
      data: {
        model: { id: "m", provider: "p" },
        isStreaming: true,
        isCompacting: false,
      },
    }),
  });
  const seen: boolean[] = [];
  const dispose = host.onStateChange((state) => seen.push(state.isStreaming));
  host.ingest({ type: "agent_start" });
  host.ingest({ type: "agent_start" });
  host.ingest({ type: "message_update", delta: "x" });
  assert.deepEqual(seen, [true]);
  const refreshed = await host.refreshState();
  assert.equal(refreshed.model, "p/m");
  // Learning the model is a real transition; an unchanged refresh stays silent.
  assert.deepEqual(seen, [true, true]);
  await host.refreshState();
  assert.deepEqual(seen, [true, true]);
  dispose();
  host.ingest({ type: "agent_settled" });
  assert.deepEqual(seen, [true, true]);
});

test("Worker host survives an unreachable channel", async () => {
  const host = createTelegramRpcWorkerHost({
    now: () => NOW,
    request: async () => {
      throw new Error("channel closed");
    },
  });
  assert.equal(await host.prompt("hello"), false);
  assert.equal(await host.refreshState().then((state) => state.isStreaming), false);
});
