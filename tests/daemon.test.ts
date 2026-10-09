/**
 * Regression tests for the external daemon host and control surface
 * Covers the inert daemon host adapter and the daemon's operator control surface.
 *
 * The daemon's live reconcile, attach, and resume paths need a spawned worker and a
 * live bus follower, so they are covered by the component suites (`supervisor`,
 * `worker-registry`, `route-registry`, `worker-control`, `worker-commands`). These
 * tests pin the wiring that had no coverage: host construction, the control surface,
 * and injected control delegation.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDaemonBridgeHost } from "../lib/daemon-host.ts";
import { createTelegramDaemon } from "../lib/daemon.ts";
import type { TelegramWorkerControlPort } from "../lib/worker-control.ts";

async function withIsolatedAgentDir<T>(
  run: (dir: string) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-daemon-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Daemon host adapter is inert, daemon-scoped, and non-Pi", async () => {
  const host = createDaemonBridgeHost({ cwd: "/daemon" });
  assert.equal(host.canLead?.(), true);
  assert.equal(
    host.helpers.getExtensionContextCwd({ cwd: "/work" } as never),
    "/work",
  );
  // The daemon has no Pi session; it falls back to one stable synthetic id.
  assert.equal(host.helpers.getExtensionContextSessionId({} as never), "daemon");
  assert.equal(
    host.helpers.getExtensionContextSessionId({
      sessionManager: { getSessionId: () => "session-x" },
    } as never),
    "session-x",
  );
  assert.equal(host.helpers.isExtensionContextIdle({} as never), true);
  assert.equal(
    host.helpers.hasExtensionContextPendingMessages({} as never),
    false,
  );
  await assert.rejects(
    async () => {
      await host.ports.sendUserMessage("hi" as never);
    },
    /does not run Pi turns/u,
  );
  await assert.rejects(
    async () => {
      await host.ports.exec("ls" as never, {} as never);
    },
    /does not execute Pi commands/u,
  );
  await assert.rejects(
    host.workerControl({ type: "get_state" }, {} as never),
    /does not own a Pi worker/u,
  );
});

test("Daemon exposes an empty, truthful control surface before any worker exists", async () => {
  await withIsolatedAgentDir(async (dir) => {
    const daemon = createTelegramDaemon({ cwd: dir });
    try {
      assert.equal(typeof daemon.epoch, "string");
      assert.ok(daemon.epoch.length > 0);
      assert.deepEqual(daemon.workers.list(), []);
      assert.deepEqual(daemon.routes.list(), []);
      const context = {
        target: { chatId: 1, threadId: 2 },
        epoch: daemon.epoch,
      };
      const list = await daemon.control.execute({ kind: "list" }, context);
      assert.match(list.html, /No live Pi workers/u);
      const status = await daemon.control.execute({ kind: "status" }, context);
      assert.match(status.html, /Daemon status/u);
      assert.match(status.html, /default/u);
      const attach = await daemon.control.execute(
        { kind: "attach", workerId: "missing" },
        context,
      );
      assert.equal(attach.ok, false);
      assert.match(attach.html, /Unknown Pi worker/u);
      const detach = await daemon.control.execute({ kind: "detach" }, context);
      // No attachment recorded for this thread: truthful no-op, never a claim.
      assert.equal(detach.ok, true);
      assert.match(detach.html, /had no attached Pi worker/u);
    } finally {
      await daemon.stop();
    }
  });
});

test("Daemon control delegates lifecycle to an injected control port", async () => {
  await withIsolatedAgentDir(async (dir) => {
    const calls: string[] = [];
    const control: TelegramWorkerControlPort = {
      start: async (spec) => {
        calls.push(`start:${spec}`);
        return { ok: true, message: "started" };
      },
      stop: async (workerId) => {
        calls.push(`stop:${workerId}`);
        return { ok: true, message: "stopped" };
      },
      restart: async (workerId) => {
        calls.push(`restart:${workerId}`);
        return { ok: true, message: "restarted" };
      },
    };
    const daemon = createTelegramDaemon({ cwd: dir, control });
    try {
      const context = {
        target: { chatId: 1, threadId: 2 },
        epoch: daemon.epoch,
      };
      assert.equal(
        (await daemon.control.execute({ kind: "start", spec: "/tmp/x" }, context)).ok,
        true,
      );
      // Stop/restart refuse an unknown worker instead of acting on a stale button.
      assert.equal(
        (await daemon.control.execute({ kind: "stop", workerId: "w1" }, context)).ok,
        false,
      );
      daemon.workers.register({
        workerId: "w1",
        kind: "attached",
        pid: 1,
        processBirthId: "w1:born",
        runtimeGeneration: 1,
        cwd: "/repo",
        sessionId: "s1",
      });
      assert.equal(
        (await daemon.control.execute({ kind: "stop", workerId: "w1" }, context)).ok,
        true,
      );
      assert.equal(
        (await daemon.control.execute({ kind: "restart", workerId: "w1" }, context)).ok,
        true,
      );
      assert.deepEqual(calls, ["start:/tmp/x", "stop:w1", "restart:w1"]);
    } finally {
      await daemon.stop();
    }
  });
});
