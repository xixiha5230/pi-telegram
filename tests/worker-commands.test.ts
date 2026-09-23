/**
 * Regression tests for daemon control menu routing
 * Covers the single /daemon entrypoint, button callbacks, target preservation,
 * leader gating, and consumption when replies fail
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getTelegramUpdateHandlerRegistry } from "../lib/updates.ts";
import { createTelegramRouteRegistry } from "../lib/route-registry.ts";
import { createTelegramWorkerRegistry } from "../lib/worker-registry.ts";
import { createTelegramWorkerControl } from "../lib/worker-control.ts";
import { registerTelegramWorkerCommands } from "../lib/worker-commands.ts";

const epoch = "epoch-1";

const registryDispatch = (data: string) =>
  getTelegramUpdateHandlerRegistry().dispatch(callback(data));

function setup(options: { renderStatus?: boolean; workerCallback?: boolean } = {}) {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const control = createTelegramWorkerControl({
    workers,
    routes,
    ...(options.renderStatus ? { renderStatus: () => "📊 <b>Daemon status</b>" } : {}),
  });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const delegated: string[] = [];
  const dispose = registerTelegramWorkerCommands({
    control,
    epoch,
    api: {
      call: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    ...(options.workerCallback
      ? {
          workerCallback: (data: string) => {
            delegated.push(data);
            return { ok: true, html: "📁 <b>Picker</b>" };
          },
        }
      : {}),
  });
  return {
    workers,
    routes,
    calls,
    delegated,
    dispose,
    registry: getTelegramUpdateHandlerRegistry(),
  };
}

const threadMessage = (text: string) => ({
  update_id: 1,
  message: {
    message_id: 10,
    text,
    chat: { id: 924128139 },
    message_thread_id: 42,
  },
});

const callback = (data: string) => ({
  update_id: 2,
  callback_query: {
    id: "cb-1",
    data,
    message: {
      message_id: 11,
      chat: { id: 924128139 },
      message_thread_id: 42,
    },
  },
});

test("Daemon menu consumes /daemon and replies with action buttons", async () => {
  const { calls, dispose, registry } = setup({ renderStatus: true });
  try {
    assert.equal(await registry.dispatch(threadMessage("/daemon")), "consume");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "sendMessage");
    assert.equal(calls[0]?.params.chat_id, 924128139);
    assert.equal(calls[0]?.params.message_thread_id, 42);
    assert.match(String(calls[0]?.params.text), /Daemon control/u);
    const markup = calls[0]?.params.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    };
    assert.deepEqual(
      markup.inline_keyboard.flat().map((button) => button.callback_data),
      ["ptw:w", "ptw:b", "ptw:t", "ptw:x"],
    );
  } finally {
    dispose();
  }
});

test("Daemon menu no longer handles any other command", async () => {
  const { calls, dispose, registry } = setup({ renderStatus: true });
  try {
    for (const text of [
      "/workers",
      "/workers start /tmp/x",
      "/attach w1",
      "/detach",
      "/status",
      "/start",
      "/help",
      "/model",
    ]) {
      assert.equal(await registry.dispatch(threadMessage(text)), "pass", text);
    }
    assert.equal(calls.length, 0);
  } finally {
    dispose();
  }
});

test("Daemon menu passes unrelated text and non-menu callbacks", async () => {
  const { calls, dispose, registry } = setup();
  try {
    assert.equal(await registry.dispatch(threadMessage("hello")), "pass");
    assert.equal(await registry.dispatch(callback("other:1")), "pass");
    assert.equal(calls.length, 0);
  } finally {
    dispose();
  }
});

test("Menu callbacks switch between menu, roster, status, and close", async () => {
  const { workers, calls, dispose, registry } = setup({ renderStatus: true });
  try {
    workers.register({
      workerId: "w1",
      kind: "attached",
      pid: 1,
      processBirthId: "w1:born",
      runtimeGeneration: 1,
      cwd: "/repo",
      sessionId: "s1",
    });
    assert.equal(await registry.dispatch(callback("ptw:w")), "consume");
    assert.equal(calls[0]?.method, "answerCallbackQuery");
    assert.equal(calls[1]?.method, "editMessageText");
    assert.match(String(calls[1]?.params.text), /Live Pi workers/u);

    calls.length = 0;
    assert.equal(await registry.dispatch(callback("ptw:m")), "consume");
    assert.match(String(calls[1]?.params.text), /Daemon control/u);

    calls.length = 0;
    assert.equal(await registry.dispatch(callback("ptw:t")), "consume");
    assert.match(String(calls[1]?.params.text), /Daemon status/u);

    calls.length = 0;
    assert.equal(await registry.dispatch(callback("ptw:x")), "consume");
    assert.match(String(calls[1]?.params.text), /Control panel closed/u);
  } finally {
    dispose();
  }
});

test("Per-worker locator button posts a marker through the locate port", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const located: string[] = [];
  const dispose = registerTelegramWorkerCommands({
    control: createTelegramWorkerControl({ workers, routes }),
    epoch,
    api: {
      call: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    locateWorker: async (workerId: string) => {
      located.push(workerId);
      return { ok: true, alert: "Marker sent into that worker's thread." };
    },
  });
  try {
    const registry = getTelegramUpdateHandlerRegistry();
    assert.equal(await registry.dispatch(callback("ptw:l:1234:born")), "consume");
    assert.deepEqual(located, ["1234:born"]);
    assert.equal(calls[0]?.method, "answerCallbackQuery");
    assert.match(String(calls[0]?.params.text), /Marker sent/u);
    assert.equal(calls.length, 1);
  } finally {
    dispose();
  }
});

test("Directory picker callbacks delegate to the browser port", async () => {
  const { calls, delegated, dispose, registry } = setup({ workerCallback: true });
  try {
    assert.equal(await registry.dispatch(callback("ptw:o:tok:0")), "consume");
    assert.deepEqual(delegated, ["ptw:o:tok:0"]);
    assert.match(String(calls[1]?.params.text), /Picker/u);
  } finally {
    dispose();
  }
});

test("Daemon menu passes every update when disabled", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const dispose = registerTelegramWorkerCommands({
    control: createTelegramWorkerControl({ workers, routes }),
    epoch,
    api: {
      call: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    enabled: () => false,
  });
  try {
    const registry = getTelegramUpdateHandlerRegistry();
    assert.equal(await registry.dispatch(threadMessage("/daemon")), "pass");
    assert.equal(await registry.dispatch(callback("ptw:w")), "pass");
    assert.equal(calls.length, 0);
  } finally {
    dispose();
  }
});

test("Daemon menu consumes even when every reply attempt fails", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const dispose = registerTelegramWorkerCommands({
    control: createTelegramWorkerControl({ workers, routes }),
    epoch,
    api: {
      call: async () => {
        throw new Error("telegram unavailable");
      },
    },
  });
  try {
    const registry = getTelegramUpdateHandlerRegistry();
    assert.equal(await registry.dispatch(threadMessage("/daemon")), "consume");
  } finally {
    dispose();
  }
});

test("Daemon menu renders only for targets the leader itself serves", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const dispose = registerTelegramWorkerCommands({
    control: createTelegramWorkerControl({ workers, routes }),
    epoch,
    api: {
      call: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    isDaemonOwnedTarget: () => false,
  });
  try {
    const registry = getTelegramUpdateHandlerRegistry();
    assert.equal(await registry.dispatch(threadMessage("/daemon")), "pass");
    assert.equal(calls.length, 0);
  } finally {
    dispose();
  }
});

test("Panel layers never close themselves and always offer the way back", async () => {
  const port = {
    start: async () => ({ ok: true, message: "started" }),
    stop: async (workerId: string) => ({ ok: true, message: `Stopped ${workerId}.` }),
    restart: async (workerId: string) => ({ ok: true, message: `Restarted ${workerId}.` }),
  };
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  workers.register({
    workerId: "w1",
    kind: "managed",
    pid: 1,
    processBirthId: "w1:born",
    runtimeGeneration: 1,
    cwd: "/repo/plugins",
    sessionId: "s1",
  });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const dispose = registerTelegramWorkerCommands({
    control: createTelegramWorkerControl({
      workers,
      routes,
      control: port,
      renderStatus: () => "📊 <b>Daemon status</b>",
    }),
    epoch,
    api: {
      call: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
  });
  const edited = () => calls.filter((call) => call.method === "editMessageText").at(-1)?.params;
  const keyboardOf = (params: Record<string, unknown> | undefined) =>
    (params?.reply_markup as { inline_keyboard: { callback_data: string }[][] } | undefined)
      ?.inline_keyboard.flat().map((button) => button.callback_data) ?? [];
  try {
    const registry = getTelegramUpdateHandlerRegistry();
    // Menu, roster, status, stop confirmation, and both lifecycle actions all keep
    // the panel open with a keyboard.
    for (const [data, expected] of [
      ["ptw:m", ["ptw:w", "ptw:b", "ptw:t", "ptw:x"]],
      ["ptw:w", ["ptw:l:w1", "ptw:z:w1", "ptw:r:w1", "ptw:b", "ptw:m"]],
      ["ptw:t", ["ptw:m"]],
      ["ptw:z:w1", ["ptw:y:w1", "ptw:c"]],
      ["ptw:c", ["ptw:l:w1", "ptw:z:w1", "ptw:r:w1", "ptw:b", "ptw:m"]],
      ["ptw:y:w1", ["ptw:l:w1", "ptw:z:w1", "ptw:r:w1", "ptw:b", "ptw:m"]],
      ["ptw:r:w1", ["ptw:l:w1", "ptw:z:w1", "ptw:r:w1", "ptw:b", "ptw:m"]],
    ] as const) {
      calls.length = 0;
      assert.equal(await registry.dispatch(callback(data)), "consume");
      assert.deepEqual(keyboardOf(edited()), [...expected], data);
      assert.ok(calls.some((call) => call.method === "editMessageText"), data);
    }
    // Only the explicit close dismisses the panel.
    calls.length = 0;
    assert.equal(await registry.dispatch(callback("ptw:x")), "consume");
    const closed = edited();
    assert.match(String(closed?.text), /Control panel closed/u);
    assert.equal(closed?.reply_markup, undefined);
  } finally {
    dispose();
  }
});

test("Daemon panel routes the Thread cleanup layer callbacks", async () => {
  const workers = createTelegramWorkerRegistry();
  const routes = createTelegramRouteRegistry();
  routes.adoptEpoch(epoch);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let enabled = false;
  const dispose = registerTelegramWorkerCommands({
    control: createTelegramWorkerControl({
      workers,
      routes,
      cleanup: {
        review: async () => ({ count: 0 }),
        isAutomaticCleanupEnabled: () => enabled,
        setAutomaticCleanup: async (next) => {
          enabled = next;
        },
      },
    }),
    epoch,
    api: {
      call: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
  });
  const lastEdit = () => calls.filter((call) => call.method === "editMessageText").at(-1)?.params;
  try {
    assert.equal(await registryDispatch("ptw:k"), "consume");
    assert.match(String(lastEdit()?.text), /Inactive Threads/u);
    calls.length = 0;
    assert.equal(await registryDispatch("ptw:j"), "consume");
    assert.match(String(calls[0]?.params.text), /No proven inactive tabs/u);
    calls.length = 0;
    assert.equal(await registryDispatch("ptw:e"), "consume");
    assert.equal(enabled, true);
    assert.match(String(lastEdit()?.text), /on/u);
  } finally {
    dispose();
  }
});
