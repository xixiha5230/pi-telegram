/**
 * Daemon worker supervisor
 * Zones: daemon control plane, supervisor boundary
 * Owns managed Pi worker processes: spawn a validated launch spec, wait for RPC
 * readiness, press the worker's Telegram connect command, hold its RPC channel for
 * supervision, stop gracefully, and restart on failure.
 * Process mechanics are injected so this policy is testable without spawning
 * anything. A managed worker never registers with Telegram: the daemon relays.
 */

import {
  createTelegramRpcWorkerHost,
  type TelegramRpcWorkerHost,
} from "./rpc-host.ts";
import {
  createTelegramRpcClient,
  splitTelegramRpcFrames,
  type TelegramRpcClient,
} from "./rpc-client.ts";
import {
  planTelegramWorkerLaunch,
  resolveTelegramWorkerIdFromPath,
  type TelegramWorkerLaunchPlan,
  type TelegramWorkerLaunchSpec,
} from "./worker-spec.ts";

export interface TelegramManagedProcess {
  pid: number;
  write: (line: string) => void;
  kill: (signal: "SIGTERM" | "SIGKILL") => void;
}

export interface TelegramManagedProcessHandlers {
  onData: (chunk: string) => void;
  onExit: (code: number | null) => void;
  onError: (error: Error) => void;
}

export interface TelegramWorkerSupervisorPorts {
  spawn: (
    plan: TelegramWorkerLaunchPlan,
    handlers: TelegramManagedProcessHandlers,
  ) => TelegramManagedProcess;
  executable: string;
  /**
   * Resolve an operator-supplied absolute directory to an existing real path.
   * Returns undefined when the path is missing, a file, or unresolvable.
   */
  resolveDirectory?: (path: string) => string | undefined;
  now?: () => number;
  /**
   * Pi command the daemon sends once the worker's RPC channel answers. The daemon
   * presses it for the operator, who never opens a terminal for a managed worker.
   */
  registerCommand?: string;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
  killTimeoutMs?: number;
  /** Maximum time to let a busy worker drain before aborting it. */
  drainTimeoutMs?: number;
  /** Poll interval while waiting for a worker to become idle. */
  drainPollIntervalMs?: number;
  restartDelayMs?: number;
  maxRestartAttempts?: number;
  /**
   * Answer one `extension_ui_request` from a managed worker. The port owns the
   * Telegram dialog and calls `respond` exactly once with a value, confirmation,
   * or cancellation. Absent means the request is cancelled immediately.
   */
  onExtensionUiRequest?: (
    workerId: string,
    request: unknown,
    respond: (
      reply: { value: string } | { confirmed: boolean } | { cancelled: true },
    ) => void,
  ) => void;
  /**
   * Daemon-provisioned bot identity env for managed workers. The worker receives
   * only the token digest, never the raw token, so its bridge keys journals,
   * admission, and pairing without holding transport authority.
   */
  getWorkerIdentityEnv?: () => Readonly<Record<string, string>> | undefined;
  recordEvent?: (message: string, details?: Record<string, unknown>) => void;
}

export interface TelegramManagedWorkerView {
  pid: number;
  spec: string;
  cwd: string;
  startedAtMs: number;
  state: "starting" | "running" | "stopping";
  /** Live Pi projection read from the worker's own RPC channel. */
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessages: number;
  model?: string;
}

/**
 * Redacted record of one managed-worker launch. It carries the operator-declared launch
 * shape only: no environment, arguments, token, or Pi session content.
 */
export interface TelegramManagedWorkerLaunchAuditEntry {
  spec: string;
  cwd: string;
  pid: number;
  session: "latest" | "new" | "resume";
  trust: TelegramWorkerLaunchSpec["trust"];
  restart: TelegramWorkerLaunchSpec["restart"];
  startedAtMs: number;
}

export interface TelegramWorkerSupervisorResult {
  ok: boolean;
  message: string;
}

export interface TelegramWorkerSupervisor {
  /**
   * Launch a managed worker in an operator-supplied absolute directory. Resuming a
   * recorded `sessionId` continues that worker's own Pi session, so the leader reuses
   * the same Telegram Thread.
   */
  startPath: (
    cwd: string,
    options?: { sessionId?: string },
  ) => TelegramWorkerSupervisorResult;
  /** RPC host for one managed worker, keyed by its stable spec name. */
  getHost: (workerId: string) => TelegramRpcWorkerHost | undefined;
  stop: (worker: string | number) => TelegramWorkerSupervisorResult;
  restart: (worker: string | number) => TelegramWorkerSupervisorResult;
  list: () => readonly TelegramManagedWorkerView[];
  /** Bounded, redacted launch audit of every managed worker this supervisor started. */
  launchAudit: () => readonly TelegramManagedWorkerLaunchAuditEntry[];
  dispose: () => void;
}

interface ManagedEntry {
  pid: number;
  specName: string;
  spec: TelegramWorkerLaunchSpec;
  startedAtMs: number;
  state: "starting" | "running" | "stopping";
  process: TelegramManagedProcess;
  rpc: TelegramRpcClient;
  host: TelegramRpcWorkerHost;
  buffer: string;
  stopping: boolean;
  restartRequested: boolean;
  restartAttempts: number;
  /** Last stderr text from the child, used to detect a missing resumed session. */
  lastErrorText?: string;
  /** A missing resumed session may fall back to a fresh session exactly once. */
  sessionFallbackUsed: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  drainStarted: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePid(worker: string | number): number | undefined {
  if (typeof worker === "number") return Number.isSafeInteger(worker) ? worker : undefined;
  const [head] = worker.split(":");
  const parsed = Number.parseInt(head, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function createTelegramWorkerSupervisor(
  ports: TelegramWorkerSupervisorPorts,
): TelegramWorkerSupervisor {
  const now = ports.now ?? Date.now;
  const registerCommand = ports.registerCommand ?? "/telegram connect";
  const readinessAttempts = ports.readinessAttempts ?? 20;
  const readinessIntervalMs = ports.readinessIntervalMs ?? 1000;
  const killTimeoutMs = ports.killTimeoutMs ?? 8000;
  const drainTimeoutMs = ports.drainTimeoutMs ?? 8000;
  const drainPollIntervalMs = ports.drainPollIntervalMs ?? 100;
  const restartDelayMs = ports.restartDelayMs ?? 2000;
  const maxRestartAttempts = ports.maxRestartAttempts ?? 5;
  const managed = new Map<number, ManagedEntry>();
  const launchAudit: TelegramManagedWorkerLaunchAuditEntry[] = [];

  const findManagedBySpec = (specName: string): ManagedEntry | undefined => {
    for (const entry of managed.values()) {
      if (entry.specName === specName) return entry;
    }
    return undefined;
  };

  const markRunning = async (entry: ManagedEntry): Promise<void> => {
    // "Running" means the worker's own Telegram bridge is connected. The worker runs
    // the same extension a terminal Pi does, so every Telegram surface (commands,
    // menus, previews, queue, voice) is the existing bridge implementation; the
    // daemon only presses the connect command for the operator.
    for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
      if (!managed.has(entry.pid)) return;
      try {
        await entry.rpc.request({ type: "get_state" }, { timeoutMs: 1500 });
        break;
      } catch {
        await sleep(readinessIntervalMs);
      }
    }
    if (!managed.has(entry.pid) || entry.stopping) return;
    try {
      await entry.rpc.request(
        { type: "prompt", message: registerCommand },
        { timeoutMs: 15_000 },
      );
      entry.state = "running";
      ports.recordEvent?.("Managed worker registered", {
        phase: "worker-register",
        pid: entry.pid,
        spec: entry.specName,
      });
    } catch (error) {
      ports.recordEvent?.("Managed worker registration failed", {
        phase: "worker-register",
        pid: entry.pid,
        spec: entry.specName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleWorkerUiRequest = (workerId: string, event: unknown): void => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    if (record.type !== "extension_ui_request" || typeof record.id !== "string") return;
    const respond = (
      reply: { value: string } | { confirmed: boolean } | { cancelled: true },
    ): void => {
      const entry = findManagedBySpec(workerId);
      if (!entry) return;
      try {
        entry.process.write(`${JSON.stringify({
          type: "extension_ui_response",
          id: record.id,
          ...reply,
        })}\n`);
      } catch (error) {
        ports.recordEvent?.("Managed worker UI response failed", {
          phase: "worker-ui-response",
          spec: workerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (!ports.onExtensionUiRequest) {
      // Fail closed: an unanswered dialog would stall the worker forever.
      respond({ cancelled: true });
      return;
    }
    try {
      ports.onExtensionUiRequest(workerId, event, respond);
    } catch (error) {
      ports.recordEvent?.("Managed worker UI request failed", {
        phase: "worker-ui-request",
        spec: workerId,
        error: error instanceof Error ? error.message : String(error),
      });
      respond({ cancelled: true });
    }
  };

  const startSpec = (
    spec: TelegramWorkerLaunchSpec,
    carried: { restartAttempts?: number; sessionFallbackUsed?: boolean } = {},
  ): TelegramWorkerSupervisorResult => {
    const running = findManagedBySpec(spec.name);
    if (running) {
      return {
        ok: false,
        message: `${spec.name} is already running (pid ${running.pid}).`,
      };
    }
    const plan = planTelegramWorkerLaunch(spec, {
      executable: ports.executable,
      identityEnv: ports.getWorkerIdentityEnv?.(),
    });
    const entry = {
      specName: spec.name,
      spec,
      startedAtMs: now(),
      state: "starting" as const,
      stopping: false,
      restartRequested: false,
      // Restart attempts accumulate across respawns, so a crash loop is bounded.
      restartAttempts: carried.restartAttempts ?? 0,
      sessionFallbackUsed: carried.sessionFallbackUsed ?? false,
      drainStarted: false,
      buffer: "",
    } as unknown as ManagedEntry;
    let hostRef: TelegramRpcWorkerHost | undefined;
    const rpc = createTelegramRpcClient({
      write: (line) => entry.process.write(line),
      onEvent: (event) => {
        hostRef?.ingest(event);
        handleWorkerUiRequest(spec.name, event);
      },
      onError: (error) => {
        ports.recordEvent?.("Managed worker RPC error", {
          phase: "worker-rpc",
          spec: spec.name,
          error: error.message,
        });
      },
    });
    entry.rpc = rpc;
    const host = createTelegramRpcWorkerHost({
      request: (command, options) => rpc.request(command, options),
      ...(ports.now ? { now: ports.now } : {}),
    });
    hostRef = host;
    entry.host = host;
    entry.process = ports.spawn(plan, {
      onData: (chunk) => {
        entry.buffer += chunk;
        const batch = splitTelegramRpcFrames(entry.buffer);
        entry.buffer = batch.rest;
        for (const frame of batch.frames) rpc.handleFrame(frame);
      },
      onExit: (code) => handleExit(entry, code),
      onError: (error) => {
        entry.lastErrorText = error.message;
        ports.recordEvent?.("Managed worker process error", {
          phase: "worker-process",
          spec: spec.name,
          error: error.message,
        });
      },
    });
    managed.set(entry.process.pid, entry);
    entry.pid = entry.process.pid;
    launchAudit.push({
      spec: spec.name,
      cwd: spec.cwd,
      pid: entry.process.pid,
      session: typeof spec.session === "object" ? "resume" : spec.session,
      trust: spec.trust,
      restart: spec.restart,
      startedAtMs: entry.startedAtMs,
    });
    if (launchAudit.length > 64) launchAudit.splice(0, launchAudit.length - 64);
    ports.recordEvent?.("Managed worker started", {
      phase: "worker-start",
      pid: entry.process.pid,
      spec: spec.name,
      cwd: spec.cwd,
    });
    void markRunning(entry);
    return {
      ok: true,
      message: `Starting ${spec.name} (pid ${entry.process.pid}) in ${spec.cwd}.`,
    };
  };

  const startPath = (
    cwd: string,
    options?: { sessionId?: string },
  ): TelegramWorkerSupervisorResult => {
    if (!ports.resolveDirectory) {
      return { ok: false, message: "Path-based launch is unavailable." };
    }
    if (typeof cwd !== "string" || !cwd.startsWith("/")) {
      return { ok: false, message: `Provide an absolute directory path: ${cwd}` };
    }
    const resolved = ports.resolveDirectory(cwd);
    if (!resolved) {
      return { ok: false, message: `Not an existing directory: ${cwd}` };
    }
    const name = resolveTelegramWorkerIdFromPath(resolved);
    return startSpec({
      name,
      cwd: resolved,
      args: [],
      env: {},
      session: options?.sessionId ? { id: options.sessionId } : "new",
      trust: "approve",
      restart: "on-failure",
      autoStart: false,
    });
  };

  const terminate = (entry: ManagedEntry): void => {
    if (!managed.has(entry.pid)) return;
    try {
      entry.process.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    entry.killTimer = setTimeout(() => {
      if (!managed.has(entry.pid)) return;
      try {
        entry.process.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, killTimeoutMs);
    entry.killTimer.unref?.();
  };

  const isIdle = (entry: ManagedEntry): boolean => {
    const state = entry.host.state();
    return !state.isStreaming && !state.isCompacting &&
      state.steering.length === 0 && state.followUp.length === 0;
  };

  const drainAndTerminate = async (entry: ManagedEntry): Promise<void> => {
    if (entry.drainStarted) return;
    entry.drainStarted = true;
    if (isIdle(entry)) {
      terminate(entry);
      return;
    }

    const deadline = now() + drainTimeoutMs;
    while (managed.has(entry.pid) && entry.stopping && now() < deadline) {
      await entry.host.refreshState();
      if (isIdle(entry)) {
        terminate(entry);
        return;
      }
      await sleep(Math.max(0, drainPollIntervalMs));
    }
    if (!managed.has(entry.pid)) return;

    // A busy worker that did not drain is explicitly aborted before transport
    // escalation. The abort is best effort; an unknown RPC outcome must never
    // prevent the bounded SIGTERM/SIGKILL shutdown path.
    ports.recordEvent?.("Managed worker drain timed out; aborting", {
      phase: "worker-drain-timeout",
      pid: entry.pid,
      spec: entry.specName,
    });
    try {
      await entry.host.abort();
    } catch {
      /* continue to bounded process termination */
    }
    terminate(entry);
  };

  const resolveEntry = (worker: string | number): ManagedEntry | undefined => {
    // A stable worker id or a spec name resolves to the same directory-derived worker.
    if (typeof worker === "string") {
      const bySpec = findManagedBySpec(worker);
      if (bySpec) return bySpec;
    }
    const pid = resolvePid(worker);
    return pid === undefined ? undefined : managed.get(pid);
  };

  const stop = (worker: string | number): TelegramWorkerSupervisorResult => {
    const entry = resolveEntry(worker);
    if (!entry) return { ok: false, message: `Unknown managed worker: ${String(worker)}` };
    if (!entry.stopping) {
      entry.stopping = true;
      entry.state = "stopping";
      void drainAndTerminate(entry);
    }
    return { ok: true, message: `Stopping ${entry.specName} (pid ${entry.pid}).` };
  };

  const restart = (worker: string | number): TelegramWorkerSupervisorResult => {
    const entry = resolveEntry(worker);
    if (!entry) return { ok: false, message: `Unknown managed worker: ${String(worker)}` };
    entry.restartRequested = true;
    return stop(entry.specName);
  };

  function handleExit(entry: ManagedEntry, code: number | null): void {
    if (entry.killTimer) clearTimeout(entry.killTimer);
    entry.rpc.close("Managed worker exited.");
    managed.delete(entry.pid);
    ports.recordEvent?.("Managed worker exited", {
      phase: "worker-exit",
      pid: entry.pid,
      spec: entry.specName,
      code,
    });
    if (entry.restartRequested) {
      startSpec(entry.spec, {
        restartAttempts: entry.restartAttempts,
        sessionFallbackUsed: entry.sessionFallbackUsed,
      });
      return;
    }
    if (entry.stopping) return;
    // A resumed session Pi cannot find (for example a worker that never received a
    // message, so no session file was written) is not a worker failure: start fresh
    // once instead of crash-looping.
    if (
      !entry.sessionFallbackUsed &&
      typeof entry.spec.session === "object" &&
      entry.lastErrorText?.includes("No session found matching")
    ) {
      ports.recordEvent?.("Managed worker session missing; starting fresh", {
        phase: "worker-session-fallback",
        pid: entry.pid,
        spec: entry.specName,
      });
      startSpec(
        { ...entry.spec, session: "new" },
        { restartAttempts: entry.restartAttempts, sessionFallbackUsed: true },
      );
      return;
    }
    if (entry.spec.restart !== "on-failure") return;
    if (code === 0) return;
    if (entry.restartAttempts >= maxRestartAttempts) {
      ports.recordEvent?.("Managed worker restart limit reached", {
        phase: "worker-restart-limit",
        spec: entry.specName,
      });
      return;
    }
    const nextAttempts = entry.restartAttempts + 1;
    entry.restartTimer = setTimeout(
      () =>
        startSpec(entry.spec, {
          restartAttempts: nextAttempts,
          sessionFallbackUsed: entry.sessionFallbackUsed,
        }),
      restartDelayMs,
    );
    entry.restartTimer.unref?.();
  }

  return {
    startPath,
    getHost: (workerId) => {
      const entry = findManagedBySpec(workerId);
      return entry?.host;
    },
    stop,
    restart,
    list: () =>
      [...managed.values()].map((entry) => {
        const live = entry.host.state();
        return {
          pid: entry.pid,
          spec: entry.specName,
          cwd: entry.spec.cwd,
          startedAtMs: entry.startedAtMs,
          state: entry.state,
          isStreaming: live.isStreaming,
          isCompacting: live.isCompacting,
          pendingMessages: live.steering.length + live.followUp.length,
          ...(live.model ? { model: live.model } : {}),
        };
      }),
    launchAudit: () => [...launchAudit],
    dispose: () => {
      for (const entry of managed.values()) {
        if (entry.killTimer) clearTimeout(entry.killTimer);
        if (entry.restartTimer) clearTimeout(entry.restartTimer);
        entry.stopping = true;
        try {
          entry.process.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      managed.clear();
    },
  };
}
