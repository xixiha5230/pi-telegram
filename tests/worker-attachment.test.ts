/**
 * Regression tests for operator Thread attachment
 * Covers `/attach`/`/detach` eligibility, re-homing, the daemon-thread guard, and
 * durable previous-Thread restore.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramRouteRegistry } from "../lib/route-registry.ts";
import type { TelegramTarget } from "../lib/target.ts";
import { createTelegramWorkerAttachmentRuntime } from "../lib/worker-attachment.ts";

interface Follower {
  target?: TelegramTarget;
  registrationGeneration?: string;
}

function setup(input: {
  follower?: Follower;
  daemonTarget?: TelegramTarget;
  replaceResult?: boolean;
} = {}) {
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch("epoch-1");
  const replaceCalls: Array<{
    workerId: string;
    target: TelegramTarget;
    oldTarget: TelegramTarget;
  }> = [];
  let follower = input.follower;
  let changes = 0;
  const runtime = createTelegramWorkerAttachmentRuntime({
    routes,
    resolveFollower: () => follower,
    replaceServeTarget: async (call) => {
      replaceCalls.push(call);
      const ok = input.replaceResult ?? true;
      if (ok) {
        // Simulate the follower re-homing its serve target.
        follower = {
          target: call.target,
          registrationGeneration: follower?.registrationGeneration,
        };
      }
      return ok;
    },
    getDaemonTarget: () => input.daemonTarget,
    epoch: "epoch-1",
    onChange: () => {
      changes += 1;
    },
  });
  return {
    runtime,
    routes,
    replaceCalls,
    changes: () => changes,
    setFollower: (next: Follower | undefined) => {
      follower = next;
    },
  };
}

const WORKER = "worker:plugins";

test("Attach re-homes a live worker Thread and records the route", async () => {
  const { runtime, routes, replaceCalls, changes } = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  const result = await runtime.attach({
    workerId: WORKER,
    target: { chatId: 7, threadId: 11 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(replaceCalls, [
    {
      workerId: WORKER,
      target: { chatId: 7, threadId: 11 },
      oldTarget: { chatId: 7, threadId: 10 },
    },
  ]);
  assert.equal(routes.resolve({ chatId: 7, threadId: 11 })?.workerId, WORKER);
  assert.equal(changes(), 1);
});

test("Attach refuses the daemon control thread", async () => {
  const { runtime, routes, replaceCalls } = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
    daemonTarget: { chatId: 7, threadId: 11 },
  });
  const result = await runtime.attach({
    workerId: WORKER,
    target: { chatId: 7, threadId: 11 },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /daemon control thread/u);
  assert.deepEqual(replaceCalls, []);
  assert.equal(routes.resolve({ chatId: 7, threadId: 11 }), undefined);
});

test("Attach fails closed on an unknown worker, cross-chat, or General thread", async () => {
  const unknown = setup({ follower: undefined });
  assert.equal(
    (await unknown.runtime.attach({ workerId: WORKER, target: { chatId: 7, threadId: 11 } })).ok,
    false,
  );
  const crossChat = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  const cross = await crossChat.runtime.attach({
    workerId: WORKER,
    target: { chatId: 8, threadId: 11 },
  });
  assert.equal(cross.ok, false);
  assert.match(cross.message, /own chat/u);
  const general = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  const noThread = await general.runtime.attach({
    workerId: WORKER,
    target: { chatId: 7 },
  });
  assert.equal(noThread.ok, false);
  assert.match(noThread.message, /forum topic/u);
});

test("Attach on the worker's own Thread is a confirmation without a move", async () => {
  const { runtime, routes, replaceCalls } = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  const result = await runtime.attach({
    workerId: WORKER,
    target: { chatId: 7, threadId: 10 },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(replaceCalls, []);
  assert.equal(routes.resolve({ chatId: 7, threadId: 10 })?.workerId, WORKER);
});

test("Detach moves the worker back and clears the route", async () => {
  const { runtime, routes, replaceCalls } = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  await runtime.attach({ workerId: WORKER, target: { chatId: 7, threadId: 11 } });
  replaceCalls.length = 0;
  const result = await runtime.detach({ target: { chatId: 7, threadId: 11 } });
  assert.equal(result.ok, true);
  assert.deepEqual(replaceCalls, [
    {
      workerId: WORKER,
      target: { chatId: 7, threadId: 10 },
      oldTarget: { chatId: 7, threadId: 11 },
    },
  ]);
  assert.equal(routes.resolve({ chatId: 7, threadId: 11 }), undefined);
});

test("Detach refuses when there is no record or the worker is not live", async () => {
  const none = setup({ follower: undefined });
  const missing = await none.runtime.detach({ target: { chatId: 7, threadId: 11 } });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /had no attached/u);

  const offline = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  await offline.runtime.attach({ workerId: WORKER, target: { chatId: 7, threadId: 11 } });
  offline.setFollower(undefined);
  const notLive = await offline.runtime.detach({ target: { chatId: 7, threadId: 11 } });
  assert.equal(notLive.ok, false);
  assert.match(notLive.message, /not live/u);
  // The record survives, so a later detach once the worker returns still restores it.
  offline.setFollower({
    target: { chatId: 7, threadId: 11 },
    registrationGeneration: "g1",
  });
  assert.equal((await offline.runtime.detach({ target: { chatId: 7, threadId: 11 } })).ok, true);
});

test("Attachments survive a serialize/restore round trip", async () => {
  const first = setup({
    follower: { target: { chatId: 7, threadId: 10 }, registrationGeneration: "g1" },
  });
  await first.runtime.attach({ workerId: WORKER, target: { chatId: 7, threadId: 11 } });
  const snapshot = first.runtime.serialize();
  assert.equal(snapshot.length, 1);

  const restored = setup({
    follower: { target: { chatId: 7, threadId: 11 }, registrationGeneration: "g1" },
  });
  restored.runtime.restore([...snapshot, { malformed: true }, null, 42]);
  const result = await restored.runtime.detach({ target: { chatId: 7, threadId: 11 } });
  assert.equal(result.ok, true);
  assert.deepEqual(restored.replaceCalls, [
    {
      workerId: WORKER,
      target: { chatId: 7, threadId: 10 },
      oldTarget: { chatId: 7, threadId: 11 },
    },
  ]);
});
