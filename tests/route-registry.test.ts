/**
 * Regression tests for the daemon route registry
 * Covers epoch fencing, target identity, worker clearing, and validation
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramRouteRegistry } from "../lib/route-registry.ts";

test("Route registry refuses mutations before an epoch is adopted", () => {
  const registry = createTelegramRouteRegistry();
  assert.deepEqual(
    registry.set({
      target: { chatId: 1, threadId: 2 },
      workerId: "worker-a",
      registrationGeneration: "g1",
      epoch: "epoch-1",
    }),
    { ok: false, reason: "no-epoch" },
  );
  assert.equal(registry.getEpoch(), undefined);
});

test("Route registry fences mutations to the adopted epoch", () => {
  const registry = createTelegramRouteRegistry();
  registry.adoptEpoch("epoch-1");
  const stored = registry.set({
    target: { chatId: 1, threadId: 2 },
    workerId: "worker-a",
    registrationGeneration: "g1",
    epoch: "epoch-1",
    nowMs: 500,
  });
  assert.equal(stored.ok, true);
  assert.deepEqual(
    registry.set({
      target: { chatId: 1, threadId: 2 },
      workerId: "worker-b",
      registrationGeneration: "g2",
      epoch: "epoch-0",
    }),
    { ok: false, reason: "stale-epoch" },
  );
  // A replaced daemon generation cannot clear the retained route either.
  assert.equal(registry.clear({ target: { chatId: 1, threadId: 2 }, epoch: "epoch-0" }), false);
  assert.equal(registry.resolve({ chatId: 1, threadId: 2 })?.workerId, "worker-a");
});

test("Route registry keys private and thread targets separately", () => {
  const registry = createTelegramRouteRegistry();
  registry.adoptEpoch("epoch-1");
  registry.set({
    target: { chatId: 1 },
    workerId: "private-worker",
    registrationGeneration: "g1",
    epoch: "epoch-1",
  });
  registry.set({
    target: { chatId: 1, threadId: 7 },
    workerId: "thread-worker",
    registrationGeneration: "g2",
    epoch: "epoch-1",
  });
  assert.equal(registry.resolve({ chatId: 1 })?.workerId, "private-worker");
  assert.equal(registry.resolve({ chatId: 1, threadId: 7 })?.workerId, "thread-worker");
  assert.equal(registry.isBound({ chatId: 1, threadId: 8 }), false);
  assert.equal(registry.list().length, 2);
});

test("Route registry clears every route owned by a replaced worker", () => {
  const registry = createTelegramRouteRegistry();
  registry.adoptEpoch("epoch-1");
  for (const threadId of [1, 2]) {
    registry.set({
      target: { chatId: 9, threadId },
      workerId: "worker-a",
      registrationGeneration: "g1",
      epoch: "epoch-1",
    });
  }
  registry.set({
    target: { chatId: 9, threadId: 3 },
    workerId: "worker-b",
    registrationGeneration: "g1",
    epoch: "epoch-1",
  });
  assert.equal(registry.clearWorker({ workerId: "worker-a", epoch: "epoch-1" }), 2);
  assert.equal(registry.clearWorker({ workerId: "worker-a", epoch: "epoch-0" }), 0);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.resolve({ chatId: 9, threadId: 3 })?.workerId, "worker-b");
});

test("Route registry rejects invalid targets and worker ids", () => {
  const registry = createTelegramRouteRegistry();
  registry.adoptEpoch("epoch-1");
  assert.deepEqual(
    registry.set({
      target: { chatId: 0 },
      workerId: "worker-a",
      registrationGeneration: "g1",
      epoch: "epoch-1",
    }),
    { ok: false, reason: "invalid-target" },
  );
  assert.deepEqual(
    registry.set({
      target: { chatId: 1, threadId: -1 },
      workerId: "worker-a",
      registrationGeneration: "g1",
      epoch: "epoch-1",
    }),
    { ok: false, reason: "invalid-target" },
  );
  assert.deepEqual(
    registry.set({
      target: { chatId: 1 },
      workerId: "",
      registrationGeneration: "g1",
      epoch: "epoch-1",
    }),
    { ok: false, reason: "invalid-worker" },
  );
});
