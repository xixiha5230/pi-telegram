/**
 * Regression tests for the daemon worker registry
 * Covers registration identity, generation fencing, heartbeat liveness, and offline transitions
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramWorkerRegistry,
  selectTelegramResumableManagedWorkers,
  TELEGRAM_WORKER_REGISTRY_CAPACITY,
} from "../lib/worker-registry.ts";

function registerInput(
  overrides: Partial<Parameters<ReturnType<typeof createTelegramWorkerRegistry>["register"]>[0]> = {},
) {
  return {
    workerId: "1234:born",
    kind: "attached" as const,
    pid: 1234,
    processBirthId: "1234:born",
    runtimeGeneration: 10,
    cwd: "/repo/a",
    sessionId: "session-a",
    nowMs: 1000,
    ...overrides,
  };
}

test("Worker registry registers a worker with a fresh registration generation", () => {
  const registry = createTelegramWorkerRegistry();
  const result = registry.register(registerInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.worker.workerId, "1234:born");
  assert.equal(result.worker.state, "ready");
  assert.equal(result.worker.connectedAtMs, 1000);
  assert.equal(result.worker.lastSeenMs, 1000);
  assert.ok(result.worker.registrationGeneration.length > 0);
  assert.equal(registry.isCurrent("1234:born", result.worker.registrationGeneration), true);
  assert.deepEqual(registry.list().map((worker) => worker.workerId), ["1234:born"]);
});

test("Worker registry rejects a worker id rebound to a different process birth", () => {
  const registry = createTelegramWorkerRegistry();
  assert.equal(registry.register(registerInput()).ok, true);
  const conflict = registry.register(
    registerInput({ processBirthId: "1234:other" }),
  );
  assert.deepEqual(conflict, { ok: false, reason: "worker-conflict" });
});

test("Worker registry replaces a stable id only when the predecessor is proven dead", () => {
  const liveness = new Map<string, "alive" | "dead" | "unverifiable">();
  const registry = createTelegramWorkerRegistry({
    getProcessBirthLiveness: (processBirthId) =>
      liveness.get(processBirthId) ?? "unverifiable",
  });
  assert.equal(registry.register(registerInput()).ok, true);
  // Unverifiable and alive predecessors keep the id.
  assert.deepEqual(
    registry.register(registerInput({ processBirthId: "1234:other" })),
    { ok: false, reason: "worker-conflict" },
  );
  liveness.set("1234:born", "alive");
  assert.deepEqual(
    registry.register(registerInput({ processBirthId: "1234:other" })),
    { ok: false, reason: "worker-conflict" },
  );
  // A proven-dead predecessor releases the id to the new process birth.
  liveness.set("1234:born", "dead");
  const replacement = registry.register(
    registerInput({ processBirthId: "1234:other", runtimeGeneration: 11 }),
  );
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;
  assert.equal(replacement.worker.processBirthId, "1234:other");
});

test("Worker registry rejects a stale runtime generation and accepts a newer replacement", () => {
  const registry = createTelegramWorkerRegistry();
  const first = registry.register(registerInput({ runtimeGeneration: 10 }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const stale = registry.register(registerInput({ runtimeGeneration: 9, nowMs: 2000 }));
  assert.deepEqual(stale, { ok: false, reason: "stale-generation" });
  const replacement = registry.register(registerInput({ runtimeGeneration: 11, nowMs: 2000 }));
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;
  assert.notEqual(
    replacement.worker.registrationGeneration,
    first.worker.registrationGeneration,
  );
  assert.equal(registry.isCurrent("1234:born", first.worker.registrationGeneration), false);
});

test("Worker registry heartbeat requires the exact registration and runtime generation", () => {
  const registry = createTelegramWorkerRegistry();
  const registered = registry.register(registerInput());
  assert.equal(registered.ok, true);
  if (!registered.ok) return;
  const { workerId, registrationGeneration } = registered.worker;

  assert.equal(
    registry.heartbeat({
      workerId,
      registrationGeneration,
      runtimeGeneration: 10,
      nowMs: 1500,
    }),
    true,
  );
  assert.equal(
    registry.heartbeat({
      workerId,
      registrationGeneration: "stale-generation",
      runtimeGeneration: 10,
      nowMs: 1600,
    }),
    false,
  );
  assert.equal(
    registry.heartbeat({
      workerId,
      registrationGeneration,
      runtimeGeneration: 99,
      nowMs: 1600,
    }),
    false,
  );
  assert.equal(registry.get(workerId)?.lastSeenMs, 1500);
});

test("Worker registry heartbeat updates project and session attributes", () => {
  const registry = createTelegramWorkerRegistry();
  const registered = registry.register(registerInput());
  assert.equal(registered.ok, true);
  if (!registered.ok) return;
  const { workerId, registrationGeneration } = registered.worker;
  assert.equal(
    registry.heartbeat({
      workerId,
      registrationGeneration,
      runtimeGeneration: 10,
      cwd: "/repo/b",
      sessionId: "session-b",
      nowMs: 2000,
    }),
    true,
  );
  const worker = registry.get(workerId);
  assert.equal(worker?.cwd, "/repo/b");
  assert.equal(worker?.sessionId, "session-b");
});

test("Worker registry unregister requires the exact registration generation", () => {
  const registry = createTelegramWorkerRegistry();
  const first = registry.register(registerInput({ runtimeGeneration: 10 }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = registry.register(registerInput({ runtimeGeneration: 11 }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    registry.unregister({
      workerId: "1234:born",
      registrationGeneration: first.worker.registrationGeneration,
    }),
    false,
  );
  assert.equal(
    registry.unregister({
      workerId: "1234:born",
      registrationGeneration: second.worker.registrationGeneration,
    }),
    true,
  );
  assert.equal(registry.list().length, 0);
});

test("Worker registry marks only non-offline workers stale after the grace window", () => {
  const registry = createTelegramWorkerRegistry();
  const registered = registry.register(registerInput({ nowMs: 1000 }));
  assert.equal(registered.ok, true);
  assert.deepEqual(registry.markStale(1500, 1000), []);
  const changed = registry.markStale(2500, 1000);
  assert.deepEqual(changed.map((worker) => worker.state), ["offline"]);
  assert.deepEqual(registry.markStale(3000, 1000), []);
});

test("Worker registry fails closed at capacity", () => {
  const registry = createTelegramWorkerRegistry();
  for (let index = 0; index < TELEGRAM_WORKER_REGISTRY_CAPACITY; index += 1) {
    const result = registry.register(
      registerInput({
        workerId: `worker-${index}`,
        processBirthId: `worker-${index}:born`,
        pid: index + 1,
      }),
    );
    assert.equal(result.ok, true);
  }
  const overflow = registry.register(
    registerInput({
      workerId: "worker-overflow",
      processBirthId: "worker-overflow:born",
    }),
  );
  assert.deepEqual(overflow, { ok: false, reason: "capacity" });
});

test("Only live managed workers are resumed after a daemon restart", () => {
  const snapshot = (overrides: Record<string, unknown>) => ({
    workerId: "w",
    kind: "managed",
    pid: 1,
    processBirthId: "w:born",
    runtimeGeneration: 1,
    cwd: "/repo/plugins",
    sessionId: "s",
    connectedAtMs: 1,
    lastSeenMs: 1,
    capabilities: [],
    ...overrides,
  });
  const selected = selectTelegramResumableManagedWorkers([
    snapshot({ workerId: "a", cwd: "/repo/plugins", sessionId: "session-a" }),
    // A second entry for the same directory is the same worker.
    snapshot({ workerId: "b", cwd: "/repo/plugins" }),
    // An attached follower belongs to the terminal that started it.
    snapshot({ workerId: "c", kind: "attached", cwd: "/repo/other" }),
    // A relative or missing directory cannot be relaunched.
    snapshot({ workerId: "d", cwd: "relative/path" }),
    snapshot({ workerId: "e", cwd: "  " }),
    snapshot({ workerId: "f", cwd: "/repo/docs" }),
  ] as never);
  assert.deepEqual(selected, [
    { workerId: "a", cwd: "/repo/plugins", sessionId: "session-a" },
    { workerId: "f", cwd: "/repo/docs", sessionId: "s" },
  ]);
});

test("A managed worker that never wrote a session is still resumable by directory", () => {
  const selected = selectTelegramResumableManagedWorkers([
    {
      workerId: "a",
      kind: "managed",
      pid: 1,
      processBirthId: "1:born",
      runtimeGeneration: 1,
      cwd: "/repo/plugins",
      sessionId: "",
      connectedAtMs: 1,
      lastSeenMs: 1,
      capabilities: [],
    },
  ]);
  // No recorded session: the daemon relaunches the directory, and the worker's stable
  // profile key reuses the same Telegram Thread instead of provisioning a new one.
  assert.deepEqual(selected, [{ workerId: "a", cwd: "/repo/plugins" }]);
});
