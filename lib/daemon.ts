/**
 * pi-telegram-daemon entry
 * Zones: daemon control plane, host boundary
 * Owns the external daemon process: it constructs the bridge core with a daemon
 * host, owns Telegram transport, and exposes start/stop for the operator.
 *
 * This is the P1 skeleton. Managed-worker process supervision is layered on top
 * through `lib/supervisor.ts`; attached workers register over the existing bus.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import * as Pi from "./pi.ts";
import * as Config from "./config.ts";
import * as Paths from "./paths.ts";
import { createTelegramBridge } from "./bridge.ts";
import { createDaemonBridgeHost } from "./daemon-host.ts";
import { createTelegramWorkerSupervisor } from "./supervisor.ts";
import { createNodeWorkerSpawnPort } from "./worker-process.ts";
import {
  createTelegramWorkerRegistry,
  selectTelegramResumableManagedWorkers,
  type TelegramWorkerRegistry,
  type TelegramWorkerSnapshot,
} from "./worker-registry.ts";
import {
  createTelegramRouteRegistry,
  type TelegramRouteRegistry,
  type TelegramRouteSnapshot,
} from "./route-registry.ts";
import {
  createTelegramDaemonFilePorts,
  createTelegramDaemonStore,
} from "./daemon-store.ts";
import {
  createTelegramWorkerControl,
  type TelegramWorkerControl,
  type TelegramWorkerControlPort,
} from "./worker-control.ts";
import { registerTelegramWorkerCommands } from "./worker-commands.ts";
import { formatTelegramUnattendedCleanupNotice } from "./thread-cleanup-manager.ts";
import { createTelegramWorkerDirectoryBrowser } from "./worker-browser.ts";
import {
  createTelegramManagedWorkerUiBridge,
  type TelegramManagedWorkerUiBridge,
} from "./worker-ui.ts";

export interface TelegramDaemonOptions {
  /** Workspace hint recorded for the daemon's own leader thread and lock. */
  cwd: string;
  /** Optional managed-worker process control; absent means start/stop is unavailable. */
  control?: TelegramWorkerControlPort;
}

interface DaemonContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: () => void;
    setStatus: () => void;
    select: () => Promise<undefined>;
    confirm: () => Promise<false>;
    input: () => Promise<undefined>;
    editor: () => Promise<undefined>;
  };
  sessionManager: {
    getSessionId: () => string;
    getEntries: () => readonly unknown[];
  };
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
}

function createDaemonContext(cwd: string): DaemonContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => "daemon",
      getEntries: () => [],
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

export interface TelegramDaemon {
  /** Daemon epoch that fences every route mutation for this process generation. */
  readonly epoch: string;
  readonly workers: TelegramWorkerRegistry;
  readonly routes: TelegramRouteRegistry;
  readonly control: TelegramWorkerControl;
  readonly workerControl: ReturnType<typeof createTelegramBridge>["ports"]["workerControl"];
  readonly ports: ReturnType<typeof createTelegramBridge>["ports"];
  readonly context: DaemonContext;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createTelegramDaemon(
  options: TelegramDaemonOptions,
): TelegramDaemon {
  const core = createTelegramBridge(
    createDaemonBridgeHost({ cwd: options.cwd }),
  );
  const context = createDaemonContext(options.cwd);
  const piContext = context as unknown as Pi.ExtensionContext;
  const store = createTelegramDaemonStore(
    createTelegramDaemonFilePorts(
      Paths.resolveTelegramProfileTempFilePath("daemon", "json"),
    ),
  );
  const persist = (): void => {
    try {
      store.save({ workers: workers.serialize(), routes: routes.serialize() });
    } catch (error) {
      core.ports.recordRuntimeEvent?.("daemon", error, { phase: "persist" });
    }
  };
  const workers = createTelegramWorkerRegistry({ onChange: persist });
  const routes = createTelegramRouteRegistry({ onChange: persist });
  const epoch = randomUUID();
  routes.adoptEpoch(epoch);
  const restored = store.load();
  const resumedWorkers = selectTelegramResumableManagedWorkers(
    (restored?.workers ?? []) as readonly TelegramWorkerSnapshot[],
  );
  if (restored) {
    workers.restore(restored.workers as readonly TelegramWorkerSnapshot[]);
    routes.restore(restored.routes as readonly TelegramRouteSnapshot[]);
  }
  // Mirror only workers this daemon spawned itself (`pi --mode rpc`). Attached
  // followers stay outside the control plane: their Telegram transport is owned by
  // the bus, and the daemon neither displays nor drives them.
  const reconcileIntervalMs = 2000;
  /**
   * Unattended cleanup cadence and the minimum proven inactivity age it will delete.
   * The guard keeps a tab you used recently; passes run often because a pass that finds
   * nothing is proof-only.
   */
  const unattendedCleanupIntervalMs = 5 * 60_000;
  const unattendedCleanupMinInactiveMs = 24 * 60 * 60_000;
  let unattendedCleanupTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  const reconcileWorkers = (): void => {
    // The control plane lists only workers this daemon spawned. They register with
    // the leader as ordinary followers, so the supervisor's managed pid set is the
    // filter: an operator-started terminal Pi keeps its own Thread but stays out.
    try {
      const managedPids = new Set(
        (supervisor?.list() ?? []).map((entry) => entry.pid),
      );
      const liveIds = new Set<string>();
      for (const follower of core.ports.busFollowers.list()) {
        const pid = follower.pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) continue;
        if (!managedPids.has(pid as number)) continue;
        const workerId = follower.instanceId;
        liveIds.add(workerId);
        const cwd = follower.cwd ?? "";
        const sessionId = follower.sessionId ?? "";
        const runtimeGeneration = follower.sessionGeneration ?? 0;
        const existing = workers.get(workerId);
        if (existing && existing.state !== "offline") {
          workers.heartbeat({
            workerId,
            registrationGeneration: existing.registrationGeneration,
            runtimeGeneration: existing.runtimeGeneration,
            cwd,
            sessionId,
            nowMs: follower.lastHeartbeatMs,
          });
        } else {
          workers.register({
            workerId,
            kind: "managed",
            pid: pid as number,
            processBirthId: follower.processBirthId ?? workerId,
            runtimeGeneration,
            cwd,
            sessionId,
          });
        }
        const worker = workers.get(workerId);
        const target = follower.target;
        if (worker && target && Number.isSafeInteger(target.threadId)) {
          const current = routes.resolve(target);
          if (
            !current ||
            current.workerId !== workerId ||
            current.registrationGeneration !== worker.registrationGeneration
          ) {
            routes.set({
              target,
              workerId,
              registrationGeneration: worker.registrationGeneration,
              epoch,
              nowMs: follower.lastHeartbeatMs,
            });
          }
        }
      }
      for (const worker of workers.list()) {
        if (liveIds.has(worker.workerId)) continue;
        workers.unregister({
          workerId: worker.workerId,
          registrationGeneration: worker.registrationGeneration,
        });
        routes.clearWorker({ workerId: worker.workerId, epoch });
      }
    } catch (error) {
      core.ports.recordRuntimeEvent?.("daemon", error, {
        phase: "reconcile-workers",
      });
    }
  };
  const supervisor = options.control
    ? undefined
    : createTelegramWorkerSupervisor({
        spawn: createNodeWorkerSpawnPort(),
        executable: process.env.PI_TELEGRAM_WORKER_EXECUTABLE ?? "pi",
        // The daemon owns the raw token. Managed workers receive only the digest,
        // so a worker never holds transport authority even though it runs the
        // same bridge extension a terminal Pi does.
        getWorkerIdentityEnv: () => {
          const identity = core.ports.configStore.getBotIdentity();
          return identity
            ? {
                [Config.TELEGRAM_WORKER_BOT_TOKEN_SHA256_ENV]: identity.tokenSha256,
                ...(identity.botId !== undefined
                  ? { [Config.TELEGRAM_WORKER_BOT_ID_ENV]: String(identity.botId) }
                  : {}),
              }
            : undefined;
        },
        resolveDirectory: (path) => {
          try {
            const resolved = realpathSync(path);
            return statSync(resolved).isDirectory() ? resolved : undefined;
          } catch {
            return undefined;
          }
        },
        onExtensionUiRequest: (workerId, request, respond) =>
          workerUi?.handleRequest(workerId, request, respond) ??
          respond({ cancelled: true }),
        recordEvent: (message, details) =>
          core.ports.recordRuntimeEvent?.("daemon", message, details),
      });
  // The managed worker registers with the bus under its follower instance id, but the
  // supervisor knows it by its directory-derived spec name. Resolve one to the other
  // through the live follower pid so dialogs target the worker's real Thread.
  const resolveWorkerUiRoute = (specName: string) => {
    const entry = supervisor?.list().find((worker) => worker.spec === specName);
    if (!entry) return undefined;
    const follower = core.ports.busFollowers
      .list()
      .find((candidate) => candidate.pid === entry.pid);
    if (!follower) return undefined;
    const route = routes
      .list()
      .find((candidate) => candidate.workerId === follower.instanceId);
    return route
      ? {
          target: route.target,
          registrationGeneration: route.registrationGeneration,
        }
      : undefined;
  };
  let workerUi: TelegramManagedWorkerUiBridge | undefined = createTelegramManagedWorkerUiBridge({
    api: core.ports.telegramApiRuntime,
    resolveRoute: resolveWorkerUiRoute,
    getAllowedUserId: core.ports.configStore.getAllowedUserId,
    recordEvent: (error, details) =>
      core.ports.recordRuntimeEvent?.("daemon", error, details),
  });
  const workerBrowser = createTelegramWorkerDirectoryBrowser({
    root: process.env.HOME ?? "/",
    listDirectories: (path) =>
      readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    resolveDirectory: (path) => {
      try {
        const resolved = realpathSync(path);
        return statSync(resolved).isDirectory() ? resolved : undefined;
      } catch {
        return undefined;
      }
    },
    onStart: (path) =>
      supervisor
        ? supervisor.startPath(path)
        : { ok: false, message: "Managed workers are unavailable." },
  });
  const escapeHtml = (value: string): string =>
    value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const describeLeader = (): string => {
    const state = core.ports.lockRuntime.getState();
    if (state.kind === "active-here") {
      return `${state.lock.instanceId ?? `pid:${state.lock.pid}`} · ${state.lock.cwd ?? "?"}`;
    }
    return state.kind;
  };
  /**
   * Unattended janitor: only runs when the operator switched it on, only proves
   * candidates older than the minimum inactivity age, and reports what it settled.
   */
  let lastUnattendedNotice: string | undefined;
  const postUnattendedNotice = async (notice: string | undefined): Promise<void> => {
    // Repeating one unchanged notice every pass is noise; a changed one is news.
    if (!notice || notice === lastUnattendedNotice) return;
    lastUnattendedNotice = notice;
    const target = core.cleanup.getLeaderTarget();
    if (!target) return;
    await core.ports.telegramApiRuntime.call("sendMessage", {
      chat_id: target.chatId,
      ...(target.threadId !== undefined
        ? { message_thread_id: target.threadId }
        : {}),
      text: notice,
      parse_mode: "HTML",
    });
  };
  const runUnattendedCleanup = async (): Promise<void> => {
    // The switch is read from disk: it can be changed by this panel, by Telegram
    // Settings in another instance, or by hand. Fail closed when it is unreadable.
    let enabled: boolean;
    try {
      enabled = await core.cleanup.resolveUnattendedCleanupEnabled();
    } catch {
      return;
    }
    if (!enabled) return;
    const inactiveBeforeMs = Date.now() - unattendedCleanupMinInactiveMs;
    try {
      // A fence left behind by an earlier attempt blocks the profile admission needed to
      // review anything, so resolve it first instead of failing every pass.
      const recovery = await core.cleanup.recoverUnresolvedFence();
      core.ports.recordRuntimeEvent?.("daemon", "Unresolved cleanup fence recovery", {
        phase: "unattended-cleanup-recovery",
        status: recovery.status,
        sawLedger: recovery.sawLedger,
        sawFence: recovery.sawFence,
        reason: recovery.reason,
      });
      if (recovery.status === "blocked") return;
      const survey = await core.cleanup.survey({ inactiveBeforeMs });
      // Every pass reports its numbers: a janitor that "does nothing" must still say why.
      core.ports.recordRuntimeEvent?.("daemon", "Unattended Thread cleanup pass", {
        phase: "unattended-cleanup-survey",
        cleanable: survey.cleanable,
        tooYoung: survey.tooYoung,
        blockedByEvidence: survey.blockedByEvidence,
        blockedByCompeting: survey.blockedByCompeting,
      });
      if (survey.cleanable === 0) {
        await postUnattendedNotice(
          survey.blockedByEvidence + survey.blockedByCompeting > 0
            ? `🧹 <b>${survey.blockedByEvidence + survey.blockedByCompeting} dormant tab(s) are blocked by live, queued, or pending evidence.</b>`
            : survey.tooYoung > 0
              ? `🧹 <b>${survey.tooYoung} proven inactive tab(s) are still inside the 24h guard.</b>`
              : undefined,
        );
        return;
      }
      // Direct deletion: the proof-only planner above already revalidated eligibility.
      const result = await core.cleanup.deleteEligible({ inactiveBeforeMs });
      if (result.deleted === 0 && result.blocked === 0) return;
      core.ports.recordRuntimeEvent?.(
        "daemon",
        "Unattended Thread cleanup settled",
        {
          phase: "unattended-cleanup",
          deleted: result.deleted,
          blocked: result.blocked,
        },
      );
      await postUnattendedNotice(
        formatTelegramUnattendedCleanupNotice({
          deleted: result.deleted,
          outcomeUnknown: 0,
          blocked: result.blocked,
        }),
      );
    } catch (error) {
      core.ports.recordRuntimeEvent?.("daemon", error, {
        phase: "unattended-cleanup",
      });
    }
  };
  const renderStatus = (): string =>
    [
      "📊 <b>Daemon status</b>",
      `Profile: <code>${escapeHtml(core.ports.configStore.getActiveProfileName() ?? "default")}</code>`,
      `Transport leader: <code>${escapeHtml(describeLeader())}</code>`,
      `Workers: ${workers.list().length} · routes: ${routes.list().length}`,
      `Epoch: <code>${escapeHtml(epoch)}</code>`,
    ].join("\n");

  const locateWorker = async (
    workerId: string,
  ): Promise<{ ok: boolean; alert?: string; html?: string }> => {
    const route = routes.list().find((entry) => entry.workerId === workerId);
    if (!route) return { ok: false, alert: "This Pi worker has no thread yet." };
    try {
      await core.ports.telegramApiRuntime.call("sendMessage", {
        chat_id: route.target.chatId,
        ...(route.target.threadId !== undefined
          ? { message_thread_id: route.target.threadId }
          : {}),
        text: "📍 <b>This Pi worker is here.</b>",
        parse_mode: "HTML",
      });
      return { ok: true, alert: "Marker sent into that worker's thread." };
    } catch (error) {
      core.ports.recordRuntimeEvent?.("daemon", error, {
        phase: "locate-worker",
      });
      return { ok: false, alert: "Could not reach that worker's thread." };
    }
  };
  const cancelWorkerUiForWorkerId = (workerId: string): void => {
    const follower = core.ports.busFollowers.get(workerId);
    if (follower?.pid === undefined) return;
    const entry = supervisor?.list().find((worker) => worker.pid === follower.pid);
    if (entry) workerUi?.cancelWorker(entry.spec);
  };
  const control = createTelegramWorkerControl({
    workers,
    routes,
    renderStatus,
    cleanup: core.cleanup,
    browse: (path) => workerBrowser.open(path),
    ...(options.control
      ? { control: options.control }
      : supervisor
        ? {
            control: {
              start: async (target) => supervisor.startPath(target),
              stop: async (worker) => {
                cancelWorkerUiForWorkerId(worker);
                return supervisor.stop(worker);
              },
              restart: async (worker) => {
                cancelWorkerUiForWorkerId(worker);
                return supervisor.restart(worker);
              },
            } satisfies TelegramWorkerControlPort,
          }
        : {}),
  });
  let disposeCommands: (() => void) | undefined;
  let disposeWorkerUi: (() => void) | undefined;
  return {
    epoch,
    workers,
    routes,
    control,
    workerControl: core.ports.workerControl,
    ports: core.ports,
    context,
    async start() {
      // The extension loads config and registers its session context during
      // session start; the daemon has no Pi session, so it does both explicitly
      // before acquiring transport.
      await core.ports.configStore.load();
      core.ports.setCurrentContext(piContext);
      // A cleanup fence left by an earlier attempt blocks every profile admission,
      // including leader-target provisioning, so it would brick startup. Clear it first.
      try {
        const swept = core.cleanup.sweepStaleCleanupFence();
        if (swept.cleared) {
          core.ports.recordRuntimeEvent?.("daemon", "Stale cleanup fence swept at startup", {
            phase: "startup-cleanup-sweep",
            backupPath: swept.backupPath,
          });
        }
      } catch (error) {
        core.ports.recordRuntimeEvent?.("daemon", error, {
          phase: "startup-cleanup-sweep",
        });
      }
      try {
        const recovery = await core.cleanup.recoverUnresolvedFence();
        core.ports.recordRuntimeEvent?.(
          "daemon",
          "Startup inactive-Thread fence recovery",
          {
            phase: "startup-cleanup-recovery",
            status: recovery.status,
            sawLedger: recovery.sawLedger,
            sawFence: recovery.sawFence,
            ...(recovery.reason ? { reason: recovery.reason } : {}),
          },
        );
      } catch (error) {
        core.ports.recordRuntimeEvent?.("daemon", error, {
          phase: "startup-cleanup-recovery",
        });
      }
      const result = await core.ports.lockedPollingRuntime.start(piContext, {
        force: true,
      });
      if (!result.ok) throw new Error(result.message);
      disposeCommands = registerTelegramWorkerCommands({
        control,
        epoch,
        api: core.ports.telegramApiRuntime,
        recordRuntimeEvent: core.ports.recordRuntimeEvent,
        workerCallback: (data) => workerBrowser.navigate(data),
        locateWorker,
        isDaemonOwnedTarget: (target) =>
          core.ports.busFollowers.getByTarget(target) === undefined,
      });
      disposeWorkerUi = workerUi?.start();
      // Relaunch the managed workers this daemon was supervising before it restarted.
      // The snapshot lists only workers that were live, so a worker the operator
      // stopped stays stopped, and a directory that disappeared is reported instead of
      // retried forever.
      for (const candidate of resumedWorkers) {
        const result = supervisor?.startPath(candidate.cwd, {
          ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
        });
        if (!result) continue;
        core.ports.recordRuntimeEvent?.(
          "daemon",
          result.ok ? "Managed worker resumed" : "Managed worker resume skipped",
          {
            phase: "worker-resume",
            workerId: candidate.workerId,
            cwd: candidate.cwd,
            ...(result.ok ? {} : { reason: result.message }),
          },
        );
      }
      reconcileWorkers();
      reconcileTimer = setInterval(reconcileWorkers, reconcileIntervalMs);
      reconcileTimer.unref?.();
      unattendedCleanupTimer = setInterval(
        () => void runUnattendedCleanup(),
        unattendedCleanupIntervalMs,
      );
      unattendedCleanupTimer.unref?.();
      // One settled pass shortly after startup, so enabling the switch has a visible
      // effect on the first daemon run instead of waiting for the first interval.
      setTimeout(() => void runUnattendedCleanup(), 15_000).unref?.();
    },
    async stop() {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = undefined;
      }
      if (unattendedCleanupTimer) {
        clearInterval(unattendedCleanupTimer);
        unattendedCleanupTimer = undefined;
      }
      disposeCommands?.();
      disposeCommands = undefined;
      disposeWorkerUi?.();
      disposeWorkerUi = undefined;
      workerUi?.dispose();
      supervisor?.dispose();
      await core.ports.lockedPollingRuntime.stop();
    },
  };
}

/**
 * CLI entry used by the `pi-telegram-daemon` bin. Keeps no policy beyond
 * argument parsing and signal wiring.
 */
export async function main(argv: readonly string[] = []): Promise<void> {
  const cwdIndex = argv.indexOf("--cwd");
  const requestedCwd =
    cwdIndex >= 0 && argv[cwdIndex + 1] ? argv[cwdIndex + 1] : undefined;
  const cwd = requestedCwd ?? process.cwd();
  const daemon = createTelegramDaemon({ cwd });
  const shutdown = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await daemon.start();
  process.stdout.write(`pi-telegram-daemon listening (cwd: ${cwd})\n`);
}
