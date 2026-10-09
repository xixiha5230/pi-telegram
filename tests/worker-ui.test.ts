/**
 * Regression tests for the managed-worker extension-UI bridge
 * Covers bounded request parsing, Telegram dialogs, callback fencing, and reply capture.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramManagedWorkerUiBridge,
  parseTelegramManagedWorkerUiRequest,
  type TelegramManagedWorkerUiReply,
} from "../lib/worker-ui.ts";

function createFixture(options: { allowedUserId?: number } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let nextMessageId = 100;
  const api = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "sendMessage") return { message_id: nextMessageId++ };
      return {};
    },
  };
  let generation = "generation-1";
  let dialogCounter = 0;
  const bridge = createTelegramManagedWorkerUiBridge({
    api,
    resolveRoute: (workerId) =>
      workerId === "worker-a"
        ? {
            target: { chatId: 7, threadId: 42 },
            registrationGeneration: generation,
          }
        : undefined,
    getAllowedUserId: () => options.allowedUserId ?? 5,
    createId: () => `dialog${(dialogCounter += 1)}`,
  });
  return {
    api,
    bridge,
    calls,
    setGeneration(value: string) {
      generation = value;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Worker UI request parser keeps only bounded dialog methods", () => {
  assert.deepEqual(
    parseTelegramManagedWorkerUiRequest({
      type: "extension_ui_request",
      id: "r1",
      method: "select",
      title: "Pick",
      options: ["a", "b"],
    }),
    { id: "r1", method: "select", title: "Pick", options: ["a", "b"] },
  );
  assert.equal(
    parseTelegramManagedWorkerUiRequest({
      type: "extension_ui_request",
      id: "r2",
      method: "select",
      title: "Pick",
      options: [],
    }),
    undefined,
  );
  assert.equal(
    parseTelegramManagedWorkerUiRequest({
      type: "extension_ui_request",
      id: "r3",
      method: "setStatus",
      statusKey: "k",
      statusText: "v",
    }),
    undefined,
  );
});

test("Worker UI confirm publishes inline buttons and answers with confirmation", async () => {
  const fixture = createFixture();
  const replies: TelegramManagedWorkerUiReply[] = [];
  fixture.bridge.handleRequest(
    "worker-a",
    {
      type: "extension_ui_request",
      id: "r1",
      method: "confirm",
      title: "Proceed?",
      message: "This is destructive.",
    },
    (reply) => replies.push(reply),
  );
  await settle();
  const send = fixture.calls.find((call) => call.method === "sendMessage");
  assert.ok(send);
  assert.equal(send.params.chat_id, 7);
  assert.equal(send.params.message_thread_id, 42);
  const keyboard = send.params.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  assert.match(keyboard.inline_keyboard[0]![0]!.callback_data, /^ptui:dialog1:0$/u);

  const verdict = await fixture.bridge.handleUpdate({
    callback_query: {
      id: "cb1",
      data: "ptui:dialog1:0",
      from: { id: 5 },
      message: { message_id: 200, chat: { id: 7 }, message_thread_id: 42 },
    },
  });
  assert.equal(verdict, "consume");
  assert.deepEqual(replies, [{ confirmed: true }]);
  assert.equal(fixture.bridge.pendingCount(), 0);
});

test("Worker UI cancels a dialog whose registration generation was replaced", async () => {
  const fixture = createFixture();
  const replies: TelegramManagedWorkerUiReply[] = [];
  fixture.bridge.handleRequest(
    "worker-a",
    { type: "extension_ui_request", id: "r1", method: "confirm", title: "Go?" },
    (reply) => replies.push(reply),
  );
  await settle();
  fixture.setGeneration("generation-2");
  const result = await fixture.bridge.handleUpdate({
    callback_query: {
      id: "cb1",
      data: "ptui:dialog1:0",
      from: { id: 5 },
      message: { message_id: 200, chat: { id: 7 }, message_thread_id: 42 },
    },
  });
  assert.equal(result, "consume");
  assert.deepEqual(replies, [{ cancelled: true }]);
  assert.equal(fixture.bridge.pendingCount(), 0);
});

test("Worker UI input dialog consumes the next matching reply", async () => {
  const fixture = createFixture();
  const replies: TelegramManagedWorkerUiReply[] = [];
  fixture.bridge.handleRequest(
    "worker-a",
    {
      type: "extension_ui_request",
      id: "r1",
      method: "input",
      title: "Name?",
      placeholder: "type a name",
    },
    (reply) => replies.push(reply),
  );
  await settle();
  const result = await fixture.bridge.handleUpdate({
    message: {
      text: "hello",
      from: { id: 5 },
      chat: { id: 7 },
      message_thread_id: 42,
    },
  });
  assert.equal(result, "consume");
  assert.deepEqual(replies, [{ value: "hello" }]);
});

test("Worker UI ignores unrelated text and unauthorized replies", async () => {
  const fixture = createFixture();
  const replies: TelegramManagedWorkerUiReply[] = [];
  fixture.bridge.handleRequest(
    "worker-a",
    { type: "extension_ui_request", id: "r1", method: "input", title: "Name?" },
    (reply) => replies.push(reply),
  );
  await settle();
  assert.equal(
    await fixture.bridge.handleUpdate({
      message: { text: "nope", from: { id: 99 }, chat: { id: 7 } },
    }),
    "pass",
  );
  assert.equal(
    await fixture.bridge.handleUpdate({
      message: { text: "nope", from: { id: 5 }, chat: { id: 8 } },
    }),
    "pass",
  );
  assert.deepEqual(replies, []);
});

test("Worker UI cancels a malformed dialog so the worker promise resolves", () => {
  const fixture = createFixture();
  const replies: TelegramManagedWorkerUiReply[] = [];
  fixture.bridge.handleRequest(
    "worker-a",
    {
      type: "extension_ui_request",
      id: "r1",
      method: "select",
      title: "Pick",
      options: [],
    },
    (reply) => replies.push(reply),
  );
  assert.deepEqual(replies, [{ cancelled: true }]);
});

test("Worker UI capacity fails closed instead of queueing unbounded dialogs", () => {
  const fixture = createFixture();
  const replies: TelegramManagedWorkerUiReply[] = [];
  for (let index = 0; index < 40; index += 1) {
    fixture.bridge.handleRequest(
      "worker-a",
      { type: "extension_ui_request", id: `r${index}`, method: "input", title: "?" },
      (reply) => replies.push(reply),
    );
  }
  assert.ok(replies.some((reply) => "cancelled" in reply && reply.cancelled));
});
