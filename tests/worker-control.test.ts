/**
 * Regression tests for the daemon worker control surface
 * Covers command parsing, list rendering, thread attachment, and control delegation
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramRouteRegistry } from "../lib/route-registry.ts";
import { createTelegramWorkerRegistry } from "../lib/worker-registry.ts";
import {
  createTelegramWorkerControl,
  parseTelegramWorkerCommand,
  renderTelegramWorkerList,
  TELEGRAM_WORKER_MENU_CALLBACKS,
  type TelegramWorkerControlPort,
} from "../lib/worker-control.ts";

const epoch = "epoch-1";

function setup(control?: TelegramWorkerControlPort) {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const surface = createTelegramWorkerControl({
    workers,
    routes,
    ...(control ? { control } : {}),
  });
  return { workers, routes, surface };
}

function registerWorker(workers: ReturnType<typeof createTelegramWorkerRegistry>) {
  const result = workers.register({
    workerId: "1234:born",
    kind: "attached",
    pid: 1234,
    processBirthId: "1234:born",
    runtimeGeneration: 1,
    cwd: "/repo/a",
    sessionId: "session-a",
    nowMs: 1000,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.worker;
}

test("Worker control parses verbs and falls back to listing", () => {
  assert.deepEqual(parseTelegramWorkerCommand(""), { kind: "list" });
  assert.deepEqual(parseTelegramWorkerCommand("start plugins"), {
    kind: "start",
    spec: "plugins",
  });
  assert.deepEqual(parseTelegramWorkerCommand("attach 1234:born"), {
    kind: "attach",
    workerId: "1234:born",
  });
  assert.deepEqual(parseTelegramWorkerCommand("detach"), { kind: "detach" });
  assert.deepEqual(parseTelegramWorkerCommand("start"), { kind: "list" });
  assert.deepEqual(parseTelegramWorkerCommand("bogus"), { kind: "list" });
});

test("Worker control renders an empty and a populated roster", () => {
  assert.match(renderTelegramWorkerList([], []), /No live Pi workers/u);
  const workers = createTelegramWorkerRegistry();
  const worker = registerWorker(workers);
  const html = renderTelegramWorkerList([worker], [
    { target: { chatId: 1, threadId: 2 }, workerId: worker.workerId },
  ]);
  assert.match(html, /Live Pi workers/u);
  assert.match(html, /1234:born/u);
  assert.match(html, /thread 2/u);
});

test("Worker control attaches and detaches the current thread", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const calls: string[] = [];
  const control: TelegramWorkerControlPort = {
    start: async () => ({ ok: true, message: "started" }),
    stop: async () => ({ ok: true, message: "stopped" }),
    restart: async () => ({ ok: true, message: "restarted" }),
    attach: async ({ workerId, target }) => {
      calls.push(`attach:${workerId}:${target.chatId}:${target.threadId}`);
      routes.set({ target, workerId, registrationGeneration: "g1", epoch });
      return { ok: true, message: "moved" };
    },
    detach: async ({ target }) => {
      calls.push(`detach:${target.chatId}:${target.threadId}`);
      routes.clear({ target, epoch });
      return { ok: true, message: "moved" };
    },
  };
  const surface = createTelegramWorkerControl({ workers, routes, control });
  const worker = registerWorker(workers);
  const target = { chatId: 1, threadId: 2 };

  const attached = await surface.execute(
    { kind: "attach", workerId: worker.workerId },
    { target, epoch },
  );
  assert.equal(attached.ok, true);
  assert.equal(routes.resolve(target)?.workerId, worker.workerId);

  const detached = await surface.execute({ kind: "detach" }, { target, epoch });
  assert.equal(detached.ok, true);
  assert.equal(routes.resolve(target), undefined);
  assert.deepEqual(calls, ["attach:1234:born:1:2", "detach:1:2"]);
});

test("Worker control refuses to attach without a re-homing port", async () => {
  const { workers, surface, routes } = setup();
  const worker = registerWorker(workers);
  const target = { chatId: 1, threadId: 2 };
  const result = await surface.execute(
    { kind: "attach", workerId: worker.workerId },
    { target, epoch },
  );
  assert.equal(result.ok, false);
  assert.equal(routes.resolve(target), undefined);
});

test("Worker control refuses to attach an unknown worker", async () => {
  const { surface, routes } = setup();
  const target = { chatId: 1 };
  const result = await surface.execute(
    { kind: "attach", workerId: "missing" },
    { target, epoch },
  );
  assert.equal(result.ok, false);
  assert.equal(routes.resolve(target), undefined);
});

test("Worker control reports managed workers unavailable without a control port", async () => {
  const { surface } = setup();
  const result = await surface.execute(
    { kind: "start", spec: "plugins" },
    { target: { chatId: 1 }, epoch },
  );
  assert.equal(result.ok, false);
  assert.match(result.html, /unavailable/u);
});

test("Worker control delegates lifecycle actions to the control port", async () => {
  const calls: string[] = [];
  const control: TelegramWorkerControlPort = {
    start: async (spec) => {
      calls.push(`start:${spec}`);
      return { ok: true, message: `started ${spec}` };
    },
    stop: async (workerId) => {
      calls.push(`stop:${workerId}`);
      return { ok: true, message: `stopped ${workerId}` };
    },
    restart: async (workerId) => {
      calls.push(`restart:${workerId}`);
      return { ok: true, message: `restarted ${workerId}` };
    },
  };
  const { surface, workers } = setup(control);
  registerWorker(workers);
  const context = { target: { chatId: 1 }, epoch };
  assert.equal(
    (await surface.execute({ kind: "start", spec: "plugins" }, context)).ok,
    true,
  );
  assert.equal(
    (await surface.execute({ kind: "stop", workerId: "1234:born" }, context)).ok,
    true,
  );
  assert.equal(
    (await surface.execute({ kind: "restart", workerId: "1234:born" }, context)).ok,
    true,
  );
  assert.deepEqual(calls, ["start:plugins", "stop:1234:born", "restart:1234:born"]);
});

function layerSetup() {
  const calls: string[] = [];
  const control: TelegramWorkerControlPort = {
    start: async () => ({ ok: true, message: "started" }),
    stop: async (workerId) => {
      calls.push(`stop:${workerId}`);
      return { ok: true, message: `Stopped ${workerId}.` };
    },
    restart: async (workerId) => {
      calls.push(`restart:${workerId}`);
      return { ok: true, message: `Restarted ${workerId}.` };
    },
  };
  const { workers, routes, surface } = setup(control);
  const worker = registerWorker(workers);
  return { workers, routes, surface, worker, calls };
}

const layerContext = { target: { chatId: 1 }, epoch };

test("Roster layers one action row per worker and never dead-ends", async () => {
  const { workers, surface, worker } = layerSetup();
  workers.register({
    workerId: "5678:born",
    kind: "managed",
    pid: 5678,
    processBirthId: "5678:born",
    runtimeGeneration: 1,
    cwd: "/repo/plugins",
    sessionId: "session-b",
  });
  const layer = await surface.execute({ kind: "list" }, layerContext);
  assert.equal(layer.ok, true);
  const rows = layer.keyboard?.inline_keyboard ?? [];
  const flat = rows.flat().map((button) => button.callback_data);
  assert.ok(flat.includes(`${TELEGRAM_WORKER_MENU_CALLBACKS.locate}${worker.workerId}`));
  assert.ok(flat.includes(`${TELEGRAM_WORKER_MENU_CALLBACKS.stopAsk}${worker.workerId}`));
  assert.ok(flat.includes(`${TELEGRAM_WORKER_MENU_CALLBACKS.restart}${worker.workerId}`));
  assert.ok(flat.includes(`${TELEGRAM_WORKER_MENU_CALLBACKS.newWorker}`));
  assert.ok(flat.includes(`${TELEGRAM_WORKER_MENU_CALLBACKS.menu}`));
  // Every worker shows its project label, and its actions sit in their own row.
  const stopRow = rows.find((row) => row[0]?.callback_data ===
    `${TELEGRAM_WORKER_MENU_CALLBACKS.stopAsk}${worker.workerId}`);
  assert.equal(stopRow?.length, 2);
  assert.match(String(rows[0]?.[0]?.text), /^📍 a$/u);
  assert.match(String(rows[2]?.[0]?.text), /^📍 plugins$/u);
});

test("Status is a layer with a way back to the menu", async () => {
  const { workers, routes } = layerSetup();
  const surface = createTelegramWorkerControl({
    workers,
    routes,
    renderStatus: () => "📊 <b>Daemon status</b>",
  });
  const layer = await surface.execute({ kind: "status" }, layerContext);
  assert.equal(layer.ok, true);
  assert.match(layer.html, /Daemon status/u);
  assert.deepEqual(layer.keyboard?.inline_keyboard, [[
    { text: "↩️ Menu", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu },
  ]]);
});

test("Stop asks first, and a lifecycle action returns to the roster", async () => {
  const { surface, worker, calls } = layerSetup();
  const ask = await surface.execute(
    { kind: "stopAsk", workerId: worker.workerId },
    layerContext,
  );
  assert.equal(ask.ok, true);
  assert.match(ask.html, /Stop a\?/u);
  const askFlat = (ask.keyboard?.inline_keyboard ?? []).flat();
  assert.ok(askFlat.some((button) => button.callback_data ===
    `${TELEGRAM_WORKER_MENU_CALLBACKS.stop}${worker.workerId}`));
  assert.ok(askFlat.some((button) => button.callback_data ===
    TELEGRAM_WORKER_MENU_CALLBACKS.backToRoster));
  assert.equal(calls.length, 0);

  const stopped = await surface.execute(
    { kind: "stop", workerId: worker.workerId },
    layerContext,
  );
  assert.deepEqual(calls, [`stop:${worker.workerId}`]);
  assert.match(stopped.html, /Live Pi workers/u);
  assert.equal(stopped.alert, `Stopped ${worker.workerId}.`);
  assert.ok(stopped.keyboard);

  const restarted = await surface.execute(
    { kind: "restart", workerId: worker.workerId },
    layerContext,
  );
  assert.deepEqual(calls, [`stop:${worker.workerId}`, `restart:${worker.workerId}`]);
  assert.match(restarted.html, /Live Pi workers/u);
  assert.equal(restarted.alert, `Restarted ${worker.workerId}.`);
});

test("Unknown workers never render a lifecycle layer", async () => {
  const { surface } = layerSetup();
  for (const kind of ["stopAsk", "stop", "restart"] as const) {
    const layer = await surface.execute({ kind, workerId: "nope" }, layerContext);
    assert.equal(layer.ok, false, kind);
    assert.match(layer.html, /Unknown Pi worker/u);
  }
});

test("Cleanup layer reports the switch and never deletes during review", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const calls: string[] = [];
  let enabled = false;
  let unattended = false;
  const surface = createTelegramWorkerControl({
    workers,
    routes,
    cleanup: {
      review: async () => {
        calls.push("review");
        return { count: 3, operationId: "thread-cleanup:" + "a".repeat(32) };
      },
      isAutomaticCleanupEnabled: () => enabled,
      setAutomaticCleanup: async (next) => {
        calls.push(`set:${next}`);
        enabled = next;
      },
      deleteEligible: async () => {
        calls.push("delete");
        return { deleted: 3, blocked: 0 };
      },
      isUnattendedCleanupEnabled: () => unattended,
      setUnattendedCleanup: async (next) => {
        calls.push(`unattended:${next}`);
        unattended = next;
      },
    },
  });
  const context = { target: { chatId: 1 }, epoch };
  const layer = await surface.execute({ kind: "cleanup" }, context);
  assert.equal(layer.ok, true);
  assert.match(layer.html, /Inactive Threads/u);
  assert.match(layer.html, /off/u);
  const flat = (layer.keyboard?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
  assert.ok(flat.includes(TELEGRAM_WORKER_MENU_CALLBACKS.cleanupReview));
  assert.ok(flat.includes(TELEGRAM_WORKER_MENU_CALLBACKS.cleanupToggle));
  assert.ok(flat.includes(TELEGRAM_WORKER_MENU_CALLBACKS.menu));

  const reviewed = await surface.execute({ kind: "cleanupReview" }, context);
  assert.equal(reviewed.ok, true);
  assert.match(reviewed.html, /3 proven inactive tab/u);
  assert.match(reviewed.html, /never deletes|Nothing was deleted/u);
  assert.deepEqual(calls, ["review"]);

  const toggled = await surface.execute({ kind: "cleanupToggle" }, context);
  assert.equal(toggled.ok, true);
  assert.deepEqual(calls, ["review", "set:true"]);
  assert.match(toggled.html, /on/u);

  // The reviewed work set can be deleted from the panel, and the unattended switch
  // is a separate, explicit decision.
  calls.length = 0;
  const reviewedLayer = await surface.execute({ kind: "cleanupReview" }, context);
  const reviewedButtons = (reviewedLayer.keyboard?.inline_keyboard ?? []).flat()
    .map((button) => button.callback_data);
  assert.ok(reviewedButtons.some((data) => data.startsWith(TELEGRAM_WORKER_MENU_CALLBACKS.cleanupDelete)));
  const deleted = await surface.execute({ kind: "cleanupDelete" }, context);
  assert.equal(deleted.ok, true);
  assert.match(deleted.html, /Deleted 3/u);
  assert.deepEqual(calls, ["review", "delete"]);
  const unattendedLayer = await surface.execute({ kind: "cleanupUnattendedToggle" }, context);
  assert.equal(unattendedLayer.ok, true);
  assert.match(unattendedLayer.html, /unattended is on/u);
  assert.deepEqual(calls.at(-1), "unattended:true");

  const failed = createTelegramWorkerControl({
    workers,
    routes,
    cleanup: {
      review: async () => {
        throw new Error("unavailable");
      },
      isAutomaticCleanupEnabled: () => true,
      setAutomaticCleanup: async () => {},
    },
  });
  const blocked = await failed.execute({ kind: "cleanupReview" }, context);
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.alert), /Could not safely review/u);
  const noPort = createTelegramWorkerControl({ workers, routes });
  assert.equal((await noPort.execute({ kind: "cleanup" }, context)).ok, false);
});

test("Cleanup appears in the menu only when the leader supplies it", async () => {
  const { workers, routes } = layerSetup();
  const withCleanup = createTelegramWorkerControl({
    workers,
    routes,
    cleanup: {
      review: async () => ({ count: 0 }),
      isAutomaticCleanupEnabled: () => false,
      setAutomaticCleanup: async () => {},
    },
  });
  const menu = await withCleanup.execute({ kind: "menu" }, layerContext);
  const flat = (menu.keyboard?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
  assert.ok(flat.includes(TELEGRAM_WORKER_MENU_CALLBACKS.cleanup));
  const withoutCleanup = createTelegramWorkerControl({ workers, routes });
  const bare = await withoutCleanup.execute({ kind: "menu" }, layerContext);
  const bareFlat = (bare.keyboard?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
  assert.equal(bareFlat.includes(TELEGRAM_WORKER_MENU_CALLBACKS.cleanup), false);
});
