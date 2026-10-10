/**
 * Telegram daemon lifecycle
 * Zones: daemon control plane, process boundary
 * Owns starting, stopping, and inspecting the external `pi-telegram-daemon` from the
 * Pi extension: it resolves the packaged daemon entrypoint, spawns it detached so it
 * survives the Pi process, and reads the durable transport-owner and daemon snapshots
 * to report truth. It never runs transport itself, never promotes, and never installs
 * OS services; the daemon remains the single transport owner.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as Paths from "./paths.ts";
import {
  createTelegramDaemonServiceInstaller,
  createTelegramDaemonServiceInstallerPorts,
  getTelegramDaemonServiceLabel,
  type TelegramDaemonServiceInstaller,
} from "./daemon-service.ts";

/** Pi session-descriptor variables a daemon must not inherit from the launching Pi. */
const INHERITED_SESSION_ENV_KEYS = [
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

export interface TelegramDaemonOwnerView {
  pid: number;
  cwd?: string;
  instanceId?: string;
  leaderEpoch?: string;
  heartbeatMs?: number;
}

export interface TelegramDaemonLifecycleDeps {
  /** Absolute path to the packaged daemon entrypoint, or undefined when absent. */
  resolveDaemonBinPath: () => string | undefined;
  getNodePath: () => string;
  getLogPath: () => string;
  /** Environment for the spawned daemon; the caller strips inherited Pi session state. */
  getEnv: () => NodeJS.ProcessEnv;
  /** Transport owner for the active profile, when a live owner exists. */
  readOwner: () => TelegramDaemonOwnerView | undefined;
  /** Daemon snapshot counts, when the daemon has persisted one. */
  readDaemonCounts: () => { workers: number; routes: number } | undefined;
  isProcessAlive: (pid: number) => boolean;
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
  /** Spawn a detached process; returns its pid, or undefined when spawn failed. */
  spawnDetached: (input: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPath: string;
  }) => number | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Resolved agent directory, passed to an installed service. */
  getAgentDir: () => string;
  /** OS service installer for login autostart. */
  service: TelegramDaemonServiceInstaller;
  /** Whether login autostart can be installed on this platform. */
  autostartSupported: () => boolean;
  recordEvent?: (message: string, details?: Record<string, unknown>) => void;
}

export interface TelegramDaemonLifecycleStatus {
  running: boolean;
  pid?: number;
  cwd?: string;
  workers?: number;
  routes?: number;
}

export interface TelegramDaemonLifecycle {
  /** Install login autostart and start the daemon; the one command to run. */
  start: (cwd: string) => Promise<{ ok: boolean; message: string }>;
  /** Remove login autostart and stop the daemon. */
  stop: () => Promise<{ ok: boolean; message: string }>;
  status: () => TelegramDaemonLifecycleStatus;
  autostartStatus: () => { installed: boolean; path?: string };
}

const START_READY_TIMEOUT_MS = 8_000;
const STOP_READY_TIMEOUT_MS = 8_000;
const READY_POLL_INTERVAL_MS = 150;

/**
 * Resolve the packaged daemon entrypoint from a module URL. The source tree keeps
 * `lib/` next to `bin/`; the built tree keeps `dist/lib/` under the same package root,
 * so the bin is one or two directories up. Return the first that exists.
 */
export function resolveTelegramDaemonBinPath(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  for (const relative of ["../bin/pi-telegram-daemon.mjs", "../../bin/pi-telegram-daemon.mjs"]) {
    try {
      const candidate = fileURLToPath(new URL(relative, moduleUrl));
      if (exists(candidate)) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Environment for a spawned daemon: the operator environment without Pi session state. */
export function telegramDaemonSpawnEnvironment(
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of INHERITED_SESSION_ENV_KEYS) delete env[key];
  return env;
}

export function createTelegramDaemonLifecycle(
  deps: TelegramDaemonLifecycleDeps,
): TelegramDaemonLifecycle {
  const liveOwner = (): TelegramDaemonOwnerView | undefined => {
    const owner = deps.readOwner();
    return owner && deps.isProcessAlive(owner.pid) ? owner : undefined;
  };

  const status = (): TelegramDaemonLifecycleStatus => {
    const owner = liveOwner();
    const counts = deps.readDaemonCounts();
    return {
      running: owner !== undefined,
      ...(owner ? { pid: owner.pid } : {}),
      ...(owner?.cwd ? { cwd: owner.cwd } : {}),
      ...(counts ? { workers: counts.workers, routes: counts.routes } : {}),
    };
  };

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
      if (predicate()) return true;
      await deps.sleep(READY_POLL_INTERVAL_MS);
    }
    return predicate();
  };

  const waitForOwner = (): Promise<boolean> =>
    waitFor(() => liveOwner() !== undefined, START_READY_TIMEOUT_MS);

  return {
    status,
    autostartStatus: () => deps.service.status(),
    async start(cwd: string) {
      const owner = liveOwner();
      if (owner) {
        return { ok: true, message: `The daemon is already running (pid ${owner.pid}).` };
      }
      const binPath = deps.resolveDaemonBinPath();
      if (!binPath) {
        return { ok: false, message: "The packaged daemon entrypoint could not be found." };
      }
      const logPath = deps.getLogPath();
      // Persistent autostart is the default: the installed service starts the daemon
      // now and at login, so `/telegram daemon start` is the one command to run.
      if (deps.autostartSupported()) {
        const installed = await deps.service.install({
          nodePath: deps.getNodePath(),
          daemonBinPath: binPath,
          cwd,
          agentDir: deps.getAgentDir(),
          logPath,
        });
        if (!installed.ok) return installed;
        if (!(await waitForOwner())) {
          return {
            ok: false,
            message: `Autostart was installed but the daemon is not ready yet. Check ${logPath}.`,
          };
        }
        const started = liveOwner();
        return {
          ok: true,
          message: `Telegram daemon listening (pid ${started?.pid}); autostart installed.`,
        };
      }
      // Unsupported platform: a detached process only, with no persistence.
      try {
        mkdirSync(dirname(logPath), { recursive: true });
      } catch {
        /* best effort */
      }
      const pid = deps.spawnDetached({
        command: deps.getNodePath(),
        args: [binPath, "--cwd", cwd],
        cwd,
        env: deps.getEnv(),
        logPath,
      });
      if (pid === undefined) {
        return { ok: false, message: "The daemon process could not be started." };
      }
      if (!(await waitForOwner())) {
        deps.recordEvent?.("Telegram daemon did not become ready", { phase: "daemon-start", pid });
        return {
          ok: false,
          message: `The daemon started (pid ${pid}) but did not take transport ownership yet. Check ${logPath}.`,
        };
      }
      const started = liveOwner();
      return { ok: true, message: `Telegram daemon listening (pid ${started?.pid ?? pid}).` };
    },
    async stop() {
      // Remove autostart first so the service cannot restart the daemon we stop.
      const removedAutostart = deps.autostartSupported()
        ? await deps.service.uninstall()
        : undefined;
      const autostartNote = removedAutostart?.ok ? " Autostart removed." : "";
      const owner = liveOwner();
      if (!owner) {
        return { ok: true, message: `The daemon is not running.${autostartNote}` };
      }
      try {
        deps.killProcess(owner.pid, "SIGTERM");
      } catch (error) {
        deps.recordEvent?.("Telegram daemon stop signal failed", {
          phase: "daemon-stop",
          pid: owner.pid,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: `Could not signal the daemon (pid ${owner.pid}).` };
      }
      const stopped = await waitFor(() => liveOwner() === undefined, STOP_READY_TIMEOUT_MS);
      return stopped
        ? { ok: true, message: `Telegram daemon stopped.${autostartNote}` }
        : { ok: false, message: `The daemon (pid ${owner.pid}) is still running.` };
    },
  };
}

/** Human-readable one-line daemon status for the command surface. */
export function formatTelegramDaemonStatus(
  status: TelegramDaemonLifecycleStatus,
): string {
  if (!status.running) return "Telegram daemon: not running.";
  const parts = [`Telegram daemon: running (pid ${status.pid})`];
  if (status.cwd) parts.push(`cwd ${status.cwd}`);
  if (status.workers !== undefined) parts.push(`workers ${status.workers}`);
  if (status.routes !== undefined) parts.push(`routes ${status.routes}`);
  return `${parts.join(" \u00b7 ")}.`;
}

/**
 * Build the production lifecycle ports from the active profile and agent dir. Kept
 * here so the composition root only passes function references, never new logic.
 */
export function createTelegramDaemonLifecyclePorts(input: {
  getProfileName: () => string | undefined;
  getAgentDir: () => string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}): TelegramDaemonLifecycleDeps {
  const profileName = () => input.getProfileName();
  const daemonStatePath = () =>
    Paths.resolveTelegramProfileTempFilePath("daemon", "json", input.getAgentDir(), profileName());
  const logPath = () =>
    Paths.resolveTelegramProfileTempFilePath("daemon", "log", input.getAgentDir(), profileName());
  return {
    resolveDaemonBinPath: () => resolveTelegramDaemonBinPath(import.meta.url),
    getNodePath: () => process.execPath,
    getLogPath: logPath,
    getEnv: () => telegramDaemonSpawnEnvironment(process.env),
    readOwner: () => readTelegramDaemonOwner(Paths.resolveTelegramOwnersPath(), profileName()),
    readDaemonCounts: () => readTelegramDaemonCounts(daemonStatePath()),
    isProcessAlive: isTelegramProcessAlive,
    killProcess: (pid, signal) => process.kill(pid, signal),
    spawnDetached: spawnDetachedTelegramDaemon,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    getAgentDir: input.getAgentDir,
    service: createTelegramDaemonServiceInstaller(
      createTelegramDaemonServiceInstallerPorts({
        homeDir: homedir(),
        recordRuntimeEvent: input.recordRuntimeEvent,
      }),
    ),
    autostartSupported: () =>
      getTelegramDaemonServiceLabel(process.platform) !== undefined,
    recordEvent: (message, details) => input.recordRuntimeEvent?.("daemon", message, details),
  };
}
export function readTelegramDaemonOwner(
  ownersPath: string,
  profileName?: string,
): TelegramDaemonOwnerView | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownersPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = (parsed as Record<string, unknown>)[profileName ?? "default"];
    if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
    const value = record as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    return {
      pid: value.pid as number,
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(typeof value.instanceId === "string" ? { instanceId: value.instanceId } : {}),
      ...(typeof value.leaderEpoch === "string" ? { leaderEpoch: value.leaderEpoch } : {}),
      ...(Number.isFinite(value.heartbeatMs) ? { heartbeatMs: value.heartbeatMs as number } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Count persisted daemon workers and routes, when a snapshot exists. */
export function readTelegramDaemonCounts(
  daemonStatePath: string,
): { workers: number; routes: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(daemonStatePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as { workers?: unknown; routes?: unknown };
    return {
      workers: Array.isArray(record.workers) ? record.workers.length : 0,
      routes: Array.isArray(record.routes) ? record.routes.length : 0,
    };
  } catch {
    return undefined;
  }
}

/** True when the pid is a live process this user can signal. */
export function isTelegramProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Spawn a detached daemon that survives this process, logging to `logPath`. */
export function spawnDetachedTelegramDaemon(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): number | undefined {
  let logFd: number | undefined;
  try {
    logFd = openSync(input.logPath, "a");
  } catch {
    logFd = undefined;
  }
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
  });
  child.unref();
  return child.pid;
}
