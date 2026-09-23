/**
 * Regression tests for managed-worker supervision
 * Covers path validation, spawn planning, readiness registration, duplicate
 * guard, graceful stop, restart, and failure restart
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { TelegramManagedProcessHandlers } from "../lib/supervisor.ts";
import { createTelegramWorkerSupervisor } from "../lib/supervisor.ts";
import type { TelegramWorkerLaunchPlan } from "../lib/worker-spec.ts";

function createFakeSpawn() {
  const procs: Array<{
    plan: TelegramWorkerLaunchPlan;
    handlers: TelegramManagedProcessHandlers;
    writes: string[];
    signals: string[];
  }> = [];
  const spawn = (
    plan: TelegramWorkerLaunchPlan,
    handlers: TelegramManagedProcessHandlers,
  ) => {
    const entry = { plan, handlers, writes: [] as string[], signals: [] as string[] };
    procs.push(entry);
    return {
      pid: 1000 + procs.length,
      write: (line: string) => {
        entry.writes.push(line);
        const request = JSON.parse(line) as { id: string; type: string };
        queueMicrotask(() =>
          handlers.onData(
            `${JSON.stringify({
              id: request.id,
              type: "response",
              command: request.type,
              success: true,
              data: {},
            })}\n`,
          ),
        );
      },
      kill: (signal: string) => {
        entry.signals.push(signal);
      },
    };
  };
  return { procs, spawn };
}

const EXISTING = new Set(["/work/plugins", "/work/docs", "/work/My Project"]);

function supervisorWith(spawn: ReturnType<typeof createFakeSpawn>["spawn"]) {
  return createTelegramWorkerSupervisor({
    spawn,
    executable: "pi",
    readinessAttempts: 1,
    readinessIntervalMs: 0,
    restartDelayMs: 0,
    resolveDirectory: (path) =>
      path.startsWith("/") && EXISTING.has(path) ? path : undefined,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("Supervisor starts a worker by path and registers the follower", async () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  const started = supervisor.startPath("/work/plugins");
  assert.equal(started.ok, true);
  assert.equal(fake.procs.length, 1);
  assert.equal(fake.procs[0]?.plan.command, "pi");
  assert.deepEqual(fake.procs[0]?.plan.args, ["--mode", "rpc", "--approve"]);
  assert.equal(fake.procs[0]?.plan.cwd, "/work/plugins");
  assert.equal(fake.procs[0]?.plan.env.PI_TELEGRAM_DAEMON, undefined);
  await tick();
  const requests =
    fake.procs[0]?.writes.map(
      (line) => JSON.parse(line) as { type: string; message?: string },
    ) ?? [];
  // Readiness is the RPC channel answering, then the daemon presses the worker's
  // Telegram connect command so the operator never opens a terminal.
  assert.deepEqual(requests.map((request) => request.type), ["get_state", "prompt"]);
  assert.equal(requests[1]?.message, "/telegram-connect");
  assert.equal(supervisor.list()[0]?.state, "running");
});

test("Supervisor projects managed worker live state from its RPC stream", () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  supervisor.startPath("/work/plugins");
  const onData = fake.procs[0]?.handlers.onData;
  assert.ok(onData);
  onData(`${JSON.stringify({ type: "agent_start" })}\n`);
  assert.equal(supervisor.list()[0]?.isStreaming, true);
  onData(`${JSON.stringify({ type: "queue_update", steering: ["a"], followUp: [] })}\n`);
  assert.equal(supervisor.list()[0]?.pendingMessages, 1);
  onData(`${JSON.stringify({ type: "agent_settled" })}\n`);
  assert.equal(supervisor.list()[0]?.isStreaming, false);
});

test("Supervisor resumes a worker's own session when asked", () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  const started = supervisor.startPath("/work/plugins", { sessionId: "01a0cc61-cdfa-7198" });
  assert.equal(started.ok, true);
  assert.deepEqual(fake.procs[0]?.plan.args, [
    "--mode",
    "rpc",
    "--approve",
    "--session",
    "01a0cc61-cdfa-7198",
  ]);
  // A fresh launch must not continue a session that belongs to someone else.
  fake.procs.length = 0;
  supervisor.stop(1001);
  fake.procs[0]?.handlers.onExit(0);
  const fresh = createFakeSpawn();
  const second = supervisorWith(fresh.spawn);
  second.startPath("/work/docs");
  assert.deepEqual(fresh.procs[0]?.plan.args, ["--mode", "rpc", "--approve"]);
});

test("A missing resumed session falls back to a fresh session once", async () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  supervisor.startPath("/work/plugins", { sessionId: "01a0cc61-cdfa-7198" });
  assert.deepEqual(fake.procs[0]?.plan.args, [
    "--mode", "rpc", "--approve", "--session", "01a0cc61-cdfa-7198",
  ]);
  fake.procs[0]?.handlers.onError(
    new Error("No session found matching '01a0cc61-cdfa-7198'"),
  );
  fake.procs[0]?.handlers.onExit(1);
  await tick();
  assert.equal(fake.procs.length, 2);
  assert.deepEqual(fake.procs[1]?.plan.args, ["--mode", "rpc", "--approve"]);
  assert.equal(supervisor.list()[0]?.state, "running");
});

test("Crash loops stay bounded because attempts accumulate across respawns", async () => {
  const fake = createFakeSpawn();
  const supervisor = createTelegramWorkerSupervisor({
    spawn: fake.spawn,
    executable: "pi",
    readinessAttempts: 1,
    readinessIntervalMs: 0,
    restartDelayMs: 0,
    maxRestartAttempts: 2,
    resolveDirectory: (path) => (EXISTING.has(path) ? path : undefined),
  });
  supervisor.startPath("/work/plugins");
  for (let round = 0; round < 5; round += 1) {
    fake.procs.at(-1)?.handlers.onExit(1);
    await tick();
  }
  // One initial launch plus exactly two restarts, then the worker stays stopped.
  assert.equal(fake.procs.length, 3);
});

test("Supervisor rejects a relative or missing directory", () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  assert.equal(supervisor.startPath("relative").ok, false);
  assert.equal(supervisor.startPath("/nowhere").ok, false);
  assert.equal(fake.procs.length, 0);
});

test("Supervisor derives a name from the directory and rejects a duplicate", () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  const started = supervisor.startPath("/work/My Project");
  assert.equal(started.ok, true);
  assert.match(started.message, /my-project/u);
  const duplicate = supervisor.startPath("/work/My Project");
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.message, /already running/u);
});

test("Supervisor stops a worker with SIGTERM and clears it on exit", () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  supervisor.startPath("/work/plugins");
  const stopped = supervisor.stop(1001);
  assert.equal(stopped.ok, true);
  assert.deepEqual(fake.procs[0]?.signals, ["SIGTERM"]);
  assert.equal(supervisor.list()[0]?.state, "stopping");
  fake.procs[0]?.handlers.onExit(0);
  assert.equal(supervisor.list().length, 0);
});

test("Supervisor restarts a failed worker on failure", async () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  supervisor.startPath("/work/plugins");
  fake.procs[0]?.handlers.onExit(1);
  await tick();
  assert.equal(fake.procs.length, 2);
});

test("Supervisor restart waits for exit before respawning", async () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  supervisor.startPath("/work/plugins");
  assert.equal(supervisor.restart(1001).ok, true);
  fake.procs[0]?.handlers.onExit(143);
  await tick();
  assert.equal(fake.procs.length, 2);
});

test("Supervisor dispose kills every managed worker", () => {
  const fake = createFakeSpawn();
  const supervisor = supervisorWith(fake.spawn);
  supervisor.startPath("/work/plugins");
  supervisor.startPath("/work/docs");
  supervisor.dispose();
  assert.deepEqual(fake.procs.map((proc) => proc.signals), [["SIGKILL"], ["SIGKILL"]]);
  assert.equal(supervisor.list().length, 0);
});
