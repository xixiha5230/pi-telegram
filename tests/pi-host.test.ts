/**
 * Regression tests for the Pi host worker-control adapter
 * Covers supported ExtensionContext operations and explicit unsupported controls.
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as Pi from "../lib/pi.ts";
import { createPiBridgeHost, createPiWorkerControlHandler } from "../lib/pi-host.ts";

function createFixture() {
  const calls: unknown[] = [];
  const model = { provider: "provider-a", id: "model-a" };
  const api = {
    sendUserMessage: async (...args: unknown[]) => { calls.push(["prompt", ...args]); },
    setModel: async (value: unknown) => { calls.push(["model", value]); return true; },
    setThinkingLevel: (value: unknown) => { calls.push(["thinking", value]); },
  } as unknown as Pi.ExtensionAPI;
  const ctx = {
    abort: () => calls.push(["abort"]),
    compact: () => calls.push(["compact"]),
    isIdle: () => false,
    hasPendingMessages: () => true,
    cwd: "/repo",
    sessionManager: { getSessionId: () => "session-a" },
    modelRegistry: { find: () => model },
    model,
    thinkingLevel: "high",
  } as unknown as Pi.ExtensionContext;
  return { calls, api, ctx };
}

test("Pi worker-control adapter uses only public ExtensionContext and API methods", async () => {
  const fixture = createFixture();
  const execute = createPiWorkerControlHandler(fixture.api);
  await execute({ type: "prompt", message: "hello" }, fixture.ctx);
  await execute({ type: "steer", message: "urgent" }, fixture.ctx);
  await execute({ type: "abort" }, fixture.ctx);
  await execute({ type: "compact" }, fixture.ctx);
  await execute({ type: "set_model", provider: "provider-a", modelId: "model-a" }, fixture.ctx);
  await execute({ type: "set_thinking_level", level: "high" }, fixture.ctx);

  assert.deepEqual(fixture.calls.map((call) => (call as unknown[])[0]), [
    "prompt", "prompt", "abort", "compact", "model", "thinking",
  ]);
  assert.deepEqual(await execute({ type: "get_state" }, fixture.ctx), {
    idle: false,
    hasPendingMessages: true,
    cwd: "/repo",
    sessionId: "session-a",
    model: { provider: "provider-a", id: "model-a" },
    thinkingLevel: "high",
  });
});

test("Pi worker-control adapter reports unsupported command-context operations", async () => {
  const fixture = createFixture();
  const execute = createPiWorkerControlHandler(fixture.api);
  await assert.rejects(
    execute({ type: "switch_session", sessionPath: "/repo/session.jsonl" }, fixture.ctx),
    /does not expose switch_session/u,
  );
});

test("A daemon-managed worker host is permanently non-leading", () => {
  const api = {} as Pi.ExtensionAPI;
  const managed = createPiBridgeHost(api, { PI_TELEGRAM_DAEMON_WORKER: "1" });
  assert.equal(managed.canLead?.(), false);
  const terminal = createPiBridgeHost(api, {});
  assert.equal(terminal.canLead, undefined);
  const unrelated = createPiBridgeHost(api, { PI_TELEGRAM_DAEMON_WORKER: "0" });
  assert.equal(unrelated.canLead, undefined);
});
