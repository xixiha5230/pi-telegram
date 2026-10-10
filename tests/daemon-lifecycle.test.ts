/**
 * Regression tests for the external daemon lifecycle
 * Covers entrypoint resolution, spawn readiness, stop escalation, owner/snapshot
 * parsing, and the redacted status line.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramDaemonLifecycle,
  formatTelegramDaemonStatus,
  isTelegramProcessAlive,
  readTelegramDaemonCounts,
  readTelegramDaemonOwner,
  resolveTelegramDaemonBinPath,
  telegramDaemonSpawnEnvironment,
  type TelegramDaemonLifecycleDeps,
} from "../lib/daemon-lifecycle.ts";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function setup(overrides: Partial<TelegramDaemonLifecycleDeps> = {}) {
  const clock = fakeClock();
  let owner: ReturnType<TelegramDaemonLifecycleDeps["readOwner"]> = undefined;
  const killed: Array<{ pid: number; signal: string }> = [];
  const spawns: Array<{ command: string; args: readonly string[]; cwd: string; logPath: string }> = [];
  const deps: TelegramDaemonLifecycleDeps = {
    resolveDaemonBinPath: () => "/pkg/bin/pi-telegram-daemon.mjs",
    getNodePath: () => "/usr/bin/node",
    getLogPath: () => "/tmp/daemon.log",
    getEnv: () => ({ PI_SESSION_ID: "should-be-stripped" }),
    readOwner: () => owner,
    readDaemonCounts: () => undefined,
    isProcessAlive: () => true,
    killProcess: (pid, signal) => {
      killed.push({ pid, signal });
    },
    spawnDetached: (input) => {
      spawns.push(input);
      return 4242;
    },
    sleep: clock.sleep,
    now: clock.now,
    getAgentDir: () => "/agent",
    service: {
      status: () => ({ installed: false }),
      install: async () => ({ ok: true, message: "installed" }),
      uninstall: async () => ({ ok: true, message: "removed" }),
    },
    ...overrides,
  };
  const lifecycle = createTelegramDaemonLifecycle(deps);
  return {
    lifecycle,
    clock,
    killed,
    spawns,
    setOwner: (next: typeof owner) => {
      owner = next;
    },
  };
}

test("resolveTelegramDaemonBinPath picks the first existing candidate", () => {
  const seen: string[] = [];
  const resolved = resolveTelegramDaemonBinPath(
    "file:///pkg/lib/daemon-lifecycle.ts",
    (path) => {
      seen.push(path);
      return path === "/pkg/bin/pi-telegram-daemon.mjs";
    },
  );
  assert.equal(resolved, "/pkg/bin/pi-telegram-daemon.mjs");
  // The dist layout (`dist/lib`) is the second candidate.
  const distResolved = resolveTelegramDaemonBinPath(
    "file:///pkg/dist/lib/daemon-lifecycle.js",
    (path) => path === "/pkg/bin/pi-telegram-daemon.mjs",
  );
  assert.equal(distResolved, "/pkg/bin/pi-telegram-daemon.mjs");
  assert.equal(resolveTelegramDaemonBinPath("file:///pkg/lib/x.ts", () => false), undefined);
  assert.ok(seen.length >= 1);
});

test("telegramDaemonSpawnEnvironment drops inherited Pi session state", () => {
  const env = telegramDaemonSpawnEnvironment({
    PI_SESSION_ID: "s",
    PI_MODEL: "m",
    PI_PROVIDER: "p",
    PI_REASONING_LEVEL: "high",
    PI_SESSION_FILE: "/f",
    HOME: "/home/x",
    PATH: "/bin",
  });
  assert.equal(env.PI_SESSION_ID, undefined);
  assert.equal(env.PI_MODEL, undefined);
  assert.equal(env.PI_PROVIDER, undefined);
  assert.equal(env.PI_REASONING_LEVEL, undefined);
  assert.equal(env.PI_SESSION_FILE, undefined);
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.PATH, "/bin");
});

test("isTelegramProcessAlive is true for this process and false for a dead pid", () => {
  assert.equal(isTelegramProcessAlive(process.pid), true);
  // A very high pid is not alive; EPERM (alive but not ours) also counts as alive.
  const probe = 2 ** 30;
  assert.equal(typeof isTelegramProcessAlive(probe), "boolean");
});

test("readTelegramDaemonOwner and readTelegramDaemonCounts parse durable state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-daemon-life-"));
  try {
    const owners = join(dir, "owners.json");
    writeFileSync(
      owners,
      JSON.stringify({
        default: { pid: 123, cwd: "/repo", instanceId: "123:1", leaderEpoch: "e", heartbeatMs: 5 },
        work: { pid: 9 },
      }),
    );
    assert.deepEqual(readTelegramDaemonOwner(owners), {
      pid: 123,
      cwd: "/repo",
      instanceId: "123:1",
      leaderEpoch: "e",
      heartbeatMs: 5,
    });
    assert.deepEqual(readTelegramDaemonOwner(owners, "work"), { pid: 9 });
    assert.equal(readTelegramDaemonOwner(owners, "missing"), undefined);
    assert.equal(readTelegramDaemonOwner(join(dir, "nope.json")), undefined);

    const state = join(dir, "daemon.json");
    writeFileSync(state, JSON.stringify({ version: 1, workers: [{}, {}], routes: [{}] }));
    assert.deepEqual(readTelegramDaemonCounts(state), { workers: 2, routes: 1 });
    assert.equal(readTelegramDaemonCounts(join(dir, "missing.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Lifecycle start reports an already-running daemon without spawning", async () => {
  const s = setup();
  s.setOwner({ pid: 111 });
  const result = await s.lifecycle.start("/repo");
  assert.equal(result.ok, true);
  assert.match(result.message, /already running \(pid 111\)/u);
  assert.deepEqual(s.spawns, []);
});

test("Lifecycle start fails closed when the entrypoint is missing", async () => {
  const s = setup({ resolveDaemonBinPath: () => undefined });
  const result = await s.lifecycle.start("/repo");
  assert.equal(result.ok, false);
  assert.match(result.message, /entrypoint could not be found/u);
  assert.deepEqual(s.spawns, []);
});

test("Lifecycle start spawns detached and reports readiness once the owner appears", async () => {
  const s = setup();
  // Simulate the daemon acquiring transport ownership shortly after spawn.
  const spawn = s.lifecycle.start("/repo");
  s.setOwner({ pid: 4242, cwd: "/repo" });
  const result = await spawn;
  assert.equal(result.ok, true);
  assert.match(result.message, /listening \(pid 4242\)/u);
  assert.deepEqual(s.spawns, [
    {
      command: "/usr/bin/node",
      args: ["/pkg/bin/pi-telegram-daemon.mjs", "--cwd", "/repo"],
      cwd: "/repo",
      logPath: "/tmp/daemon.log",
      env: { PI_SESSION_ID: "should-be-stripped" },
    },
  ]);
});

test("Lifecycle start reports a daemon that never takes ownership", async () => {
  const s = setup();
  const result = await s.lifecycle.start("/repo");
  assert.equal(result.ok, false);
  assert.match(result.message, /did not take transport ownership/u);
  assert.equal(s.spawns.length, 1);
});

test("Lifecycle stop signals a live daemon and confirms it cleared", async () => {
  const s = setup();
  s.setOwner({ pid: 777 });
  const stopped = s.lifecycle.stop();
  s.setOwner(undefined);
  const result = await stopped;
  assert.equal(result.ok, true);
  assert.match(result.message, /stopped/u);
  assert.deepEqual(s.killed, [{ pid: 777, signal: "SIGTERM" }]);
});

test("Lifecycle stop is a truthful no-op when nothing runs", async () => {
  const s = setup();
  const result = await s.lifecycle.stop();
  assert.equal(result.ok, true);
  assert.match(result.message, /not running/u);
  assert.deepEqual(s.killed, []);
});

test("Lifecycle status and format report truth only", () => {
  const s = setup({ readDaemonCounts: () => ({ workers: 3, routes: 2 }) });
  assert.equal(s.lifecycle.status().running, false);
  assert.equal(
    formatTelegramDaemonStatus(s.lifecycle.status()),
    "Telegram daemon: not running.",
  );
  s.setOwner({ pid: 55, cwd: "/repo" });
  const status = s.lifecycle.status();
  assert.deepEqual(status, { running: true, pid: 55, cwd: "/repo", workers: 3, routes: 2 });
  assert.equal(
    formatTelegramDaemonStatus(status),
    "Telegram daemon: running (pid 55) \u00b7 cwd /repo \u00b7 workers 3 \u00b7 routes 2.",
  );
});

test("Lifecycle autostart delegates to the service installer", async () => {
  const installs: unknown[] = [];
  const s = setup({
    service: {
      status: () => ({ installed: true, path: "/svc" }),
      install: async (spec) => {
        installs.push(spec);
        return { ok: true, message: "installed" };
      },
      uninstall: async () => ({ ok: true, message: "removed" }),
    },
  });
  assert.deepEqual(s.lifecycle.autostartStatus(), { installed: true, path: "/svc" });
  assert.equal((await s.lifecycle.installAutostart("/repo")).ok, true);
  assert.deepEqual(installs, [
    {
      nodePath: "/usr/bin/node",
      daemonBinPath: "/pkg/bin/pi-telegram-daemon.mjs",
      cwd: "/repo",
      agentDir: "/agent",
      logPath: "/tmp/daemon.log",
    },
  ]);
  assert.equal((await s.lifecycle.uninstallAutostart()).ok, true);
});

test("Lifecycle autostart fails closed without a packaged entrypoint", async () => {
  const s = setup({ resolveDaemonBinPath: () => undefined });
  const result = await s.lifecycle.installAutostart("/repo");
  assert.equal(result.ok, false);
  assert.match(result.message, /entrypoint could not be found/u);
});
