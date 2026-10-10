/**
 * Regression tests for the bounded worker-control protocol
 * Covers command allowlisting, wire limits, and registration-generation fencing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeTelegramWorkerControl,
  executeTelegramWorkerControl,
  parseTelegramWorkerControlCommand,
} from "../lib/worker-control-protocol.ts";

test("Worker control parser accepts the bounded command allowlist", () => {
  assert.deepEqual(
    parseTelegramWorkerControlCommand({
      type: "prompt",
      message: "continue",
      deliverAs: "followUp",
    }),
    { type: "prompt", message: "continue", deliverAs: "followUp" },
  );
  assert.deepEqual(
    parseTelegramWorkerControlCommand({
      type: "switch_session",
      sessionPath: "/tmp/session.jsonl",
    }),
    { type: "switch_session", sessionPath: "/tmp/session.jsonl" },
  );
  assert.deepEqual(
    parseTelegramWorkerControlCommand({
      type: "set_model",
      provider: "provider",
      modelId: "model",
    }),
    { type: "set_model", provider: "provider", modelId: "model" },
  );
});

test("Worker control parser rejects shell-like and malformed commands", () => {
  assert.equal(parseTelegramWorkerControlCommand({ type: "bash", command: "rm -rf /" }), undefined);
  assert.equal(parseTelegramWorkerControlCommand({ type: "prompt", message: "" }), undefined);
  assert.equal(parseTelegramWorkerControlCommand({ type: "prompt", message: "/bash ls" }), undefined);
  assert.equal(parseTelegramWorkerControlCommand({ type: "steer", message: " /telegram connect" }), undefined);
  assert.equal(parseTelegramWorkerControlCommand({ type: "switch_session", sessionPath: "relative.jsonl" }), undefined);
  assert.equal(parseTelegramWorkerControlCommand({ type: "set_model", provider: "p" }), undefined);
  assert.equal(
    parseTelegramWorkerControlCommand({ type: "prompt", message: "x".repeat(200_001) }),
    undefined,
  );
});

test("Worker control authorization fails closed on stale registration generation", () => {
  const command = parseTelegramWorkerControlCommand({ type: "abort" });
  assert.ok(command);
  const envelope = {
    kind: "worker.control" as const,
    requestId: "r1",
    workerId: "worker-a",
    registrationGeneration: "generation-2",
    command,
  };
  assert.equal(
    authorizeTelegramWorkerControl(envelope, {
      workerId: "worker-a",
      registrationGeneration: "generation-1",
    }).ok,
    false,
  );
});

test("Worker control executes only the current generation and returns a reply", async () => {
  const command = parseTelegramWorkerControlCommand({ type: "get_state" });
  assert.ok(command);
  const calls: unknown[] = [];
  const reply = await executeTelegramWorkerControl(
    {
      kind: "worker.control",
      requestId: "r2",
      workerId: "worker-a",
      registrationGeneration: "generation-1",
      command,
    },
    { workerId: "worker-a", registrationGeneration: "generation-1" },
    { execute: (value) => { calls.push(value); return { idle: true }; } },
  );
  assert.deepEqual(calls, [command]);
  assert.deepEqual(reply.result, { ok: true, result: { idle: true } });

  const stale = await executeTelegramWorkerControl(
    {
      kind: "worker.control",
      requestId: "r3",
      workerId: "worker-a",
      registrationGeneration: "generation-0",
      command,
    },
    { workerId: "worker-a", registrationGeneration: "generation-1" },
    { execute: () => { throw new Error("must not execute stale command"); } },
  );
  assert.equal(stale.result.ok, false);
});
