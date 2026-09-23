/**
 * Regression tests for daemon control-plane persistence
 * Covers snapshot validation, worker hint restore/offline semantics, route restore, and change hooks
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramDaemonStore,
  TELEGRAM_DAEMON_STATE_VERSION,
} from "../lib/daemon-store.ts";
import { createTelegramWorkerRegistry } from "../lib/worker-registry.ts";
import { createTelegramRouteRegistry } from "../lib/route-registry.ts";

function createPorts(initial?: string) {
  let text = initial;
  return {
    ports: {
      read: () => text,
      write: (payload: string) => {
        text = payload;
      },
    },
    current: () => text,
  };
}

test("Daemon store round-trips a valid snapshot", () => {
  const memory = createPorts();
  const store = createTelegramDaemonStore(memory.ports);
  store.save({ workers: [{ workerId: "w1" }], routes: [] });
  const loaded = store.load();
  assert.deepEqual(loaded, { workers: [{ workerId: "w1" }], routes: [] });
  assert.match(String(memory.current()), new RegExp(`"version":${TELEGRAM_DAEMON_STATE_VERSION}`));
});

test("Daemon store rejects malformed or version-mismatched snapshots", () => {
  assert.equal(
    createTelegramDaemonStore(createPorts("not json").ports).load(),
    undefined,
  );
  assert.equal(
    createTelegramDaemonStore(createPorts('{"version":99,"workers":[],"routes":[]}').ports).load(),
    undefined,
  );
  assert.equal(
    createTelegramDaemonStore(createPorts('{"version":1,"workers":{}}').ports).load(),
    undefined,
  );
});

test("Worker registry persists structural changes and restores hints as offline", () => {
  let changes = 0;
  const workers = createTelegramWorkerRegistry({ onChange: () => { changes += 1; } });
  const registered = workers.register({
    workerId: "w1",
    kind: "attached",
    pid: 1,
    processBirthId: "w1:born",
    runtimeGeneration: 5,
    cwd: "/repo",
    sessionId: "s1",
  });
  assert.equal(registered.ok, true);
  assert.equal(changes, 1);
  const snapshot = workers.serialize();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.runtimeGeneration, 5);

  const restored = createTelegramWorkerRegistry();
  restored.restore(snapshot);
  assert.equal(restored.get("w1")?.state, "offline");
  // An offline hint may be replaced by a new process birth.
  const replacement = restored.register({
    workerId: "w1",
    kind: "attached",
    pid: 2,
    processBirthId: "w1:reborn",
    runtimeGeneration: 6,
    cwd: "/repo",
    sessionId: "s2",
  });
  assert.equal(replacement.ok, true);
  assert.equal(replacement.ok && replacement.worker.state, "ready");
});

test("Route registry persists changes and restores under the current epoch", () => {
  let changes = 0;
  const routes = createTelegramRouteRegistry({ onChange: () => { changes += 1; } });
  routes.adoptEpoch("epoch-a");
  routes.set({
    target: { chatId: 1, threadId: 2 },
    workerId: "w1",
    registrationGeneration: "g1",
    epoch: "epoch-a",
  });
  assert.equal(changes, 1);
  const snapshot = routes.serialize();

  const restarted = createTelegramRouteRegistry();
  restarted.adoptEpoch("epoch-b");
  restarted.restore(snapshot);
  assert.equal(restarted.resolve({ chatId: 1, threadId: 2 })?.workerId, "w1");
  // Restored routes carry the restarted daemon's epoch and fence correctly.
  assert.equal(restarted.resolve({ chatId: 1, threadId: 2 })?.epoch, "epoch-b");
  assert.equal(
    restarted.clear({ target: { chatId: 1, threadId: 2 }, epoch: "epoch-a" }),
    false,
  );
  assert.equal(
    restarted.clear({ target: { chatId: 1, threadId: 2 }, epoch: "epoch-b" }),
    true,
  );
});
