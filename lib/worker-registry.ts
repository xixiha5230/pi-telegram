/**
 * Telegram daemon worker registry
 * Zones: daemon control plane, multi-instance bus
 * Owns live worker identity, registration-generation fencing, heartbeat liveness,
 * and explicit offline/unregister transitions for daemon-managed and attached Pi
 * workers. It never spawns, probes, or kills processes; the daemon owns those
 * mechanics and only reports liveness it can actually prove.
 */

import { randomUUID } from "node:crypto";

export const TELEGRAM_WORKER_REGISTRY_CAPACITY = 64;

export type TelegramWorkerKind = "managed" | "attached";

export type TelegramWorkerState = "ready" | "draining" | "offline";

export interface TelegramWorkerRegistrationInput {
  /** Stable worker identity derived from process identity by the caller. */
  workerId: string;
  kind: TelegramWorkerKind;
  pid: number;
  processBirthId: string;
  runtimeGeneration: number;
  cwd: string;
  sessionId: string;
  protocol?: string;
  capabilities?: readonly string[];
  nowMs?: number;
}

export interface TelegramWorkerView {
  workerId: string;
  kind: TelegramWorkerKind;
  pid: number;
  processBirthId: string;
  runtimeGeneration: number;
  cwd: string;
  sessionId: string;
  registrationGeneration: string;
  connectedAtMs: number;
  lastSeenMs: number;
  state: TelegramWorkerState;
  protocol?: string;
  capabilities: readonly string[];
}

export type TelegramWorkerRegistrationReason =
  | "invalid"
  | "capacity"
  | "worker-conflict"
  | "stale-generation";

export type TelegramWorkerRegistrationResult =
  | { ok: true; worker: TelegramWorkerView }
  | { ok: false; reason: TelegramWorkerRegistrationReason };

export interface TelegramWorkerHeartbeatInput {
  workerId: string;
  registrationGeneration: string;
  runtimeGeneration: number;
  cwd?: string;
  sessionId?: string;
  state?: TelegramWorkerState;
  nowMs?: number;
}

export interface TelegramWorkerSnapshot {
  workerId: string;
  kind: TelegramWorkerKind;
  pid: number;
  processBirthId: string;
  runtimeGeneration: number;
  cwd: string;
  sessionId: string;
  connectedAtMs: number;
  lastSeenMs: number;
  protocol?: string;
  capabilities: readonly string[];
}

/**
 * Workers to relaunch when the daemon starts again.
 *
 * The snapshot lists exactly the workers that were live, so a worker the operator
 * stopped is absent and is never resurrected. Only managed workers are the daemon's to
 * relaunch; an attached follower belongs to the terminal that started it. Entries are
 * deduplicated by directory because a managed worker is identified by its directory.
 */
export function selectTelegramResumableManagedWorkers(
  snapshots: readonly TelegramWorkerSnapshot[],
): readonly { workerId: string; cwd: string; sessionId?: string }[] {
  const byCwd = new Map<
    string,
    { workerId: string; cwd: string; sessionId?: string }
  >();
  for (const snapshot of snapshots) {
    if (snapshot.kind !== "managed") continue;
    const cwd = typeof snapshot.cwd === "string" ? snapshot.cwd.trim() : "";
    if (!cwd.startsWith("/") || byCwd.has(cwd)) continue;
    const sessionId =
      typeof snapshot.sessionId === "string" ? snapshot.sessionId.trim() : "";
    // Resuming this worker's own recorded session re-keys the same Telegram Thread
    // instead of provisioning a new one, and never picks up another instance's
    // session for the same directory.
    byCwd.set(cwd, { workerId: snapshot.workerId, cwd, ...(sessionId ? { sessionId } : {}) });
  }
  return [...byCwd.values()];
}

export interface TelegramWorkerRegistryOptions {
  /** Called after a structural change worth persisting (not on heartbeat). */
  onChange?: () => void;
  /**
   * Process-birth liveness for a stable worker id. A new process birth may replace a
   * predecessor only when that predecessor is proven dead; an alive or unverifiable
   * predecessor keeps the id, so a live worker is never silently replaced.
   */
  getProcessBirthLiveness?: (
    processBirthId: string,
  ) => "alive" | "dead" | "unverifiable";
}

export interface TelegramWorkerRegistry {
  register: (
    input: TelegramWorkerRegistrationInput,
  ) => TelegramWorkerRegistrationResult;
  heartbeat: (input: TelegramWorkerHeartbeatInput) => boolean;
  unregister: (input: {
    workerId: string;
    registrationGeneration: string;
  }) => boolean;
  isCurrent: (workerId: string, registrationGeneration: string) => boolean;
  get: (workerId: string) => TelegramWorkerView | undefined;
  list: () => readonly TelegramWorkerView[];
  markStale: (nowMs: number, graceMs: number) => readonly TelegramWorkerView[];
  serialize: () => readonly TelegramWorkerSnapshot[];
  restore: (snapshots: readonly TelegramWorkerSnapshot[]) => void;
  clear: () => void;
}

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidWorkerId(workerId: string): boolean {
  return workerId.length > 0 && workerId.length <= 256;
}

export function createTelegramWorkerRegistry(
  options: TelegramWorkerRegistryOptions = {},
): TelegramWorkerRegistry {
  const workers = new Map<string, TelegramWorkerView>();

  const register = (
    input: TelegramWorkerRegistrationInput,
  ): TelegramWorkerRegistrationResult => {
    if (
      !isValidWorkerId(input.workerId) ||
      !isSafeInteger(input.pid) ||
      !isValidWorkerId(input.processBirthId) ||
      !Number.isSafeInteger(input.runtimeGeneration)
    ) {
      return { ok: false, reason: "invalid" };
    }
    const existing = workers.get(input.workerId);
    if (existing && existing.state !== "offline") {
      // A stable worker id may be re-registered by a new process birth once the
      // previous process is proven dead; otherwise the id stays bound to its birth.
      if (existing.processBirthId !== input.processBirthId) {
        const predecessorLiveness =
          options.getProcessBirthLiveness?.(existing.processBirthId) ?? "unverifiable";
        if (predecessorLiveness !== "dead") {
          return { ok: false, reason: "worker-conflict" };
        }
      } else if (input.runtimeGeneration < existing.runtimeGeneration) {
        // Runtime generation only moves forward for one worker id and process birth.
        return { ok: false, reason: "stale-generation" };
      }
    } else if (!existing && workers.size >= TELEGRAM_WORKER_REGISTRY_CAPACITY) {
      return { ok: false, reason: "capacity" };
    }
    const nowMs = input.nowMs ?? Date.now();
    const worker: TelegramWorkerView = {
      workerId: input.workerId,
      kind: input.kind,
      pid: input.pid,
      processBirthId: input.processBirthId,
      runtimeGeneration: input.runtimeGeneration,
      cwd: input.cwd,
      sessionId: input.sessionId,
      registrationGeneration: randomUUID(),
      connectedAtMs: nowMs,
      lastSeenMs: nowMs,
      state: "ready",
      ...(input.protocol ? { protocol: input.protocol } : {}),
      capabilities: [...(input.capabilities ?? [])],
    };
    workers.set(input.workerId, worker);
    options.onChange?.();
    return { ok: true, worker };
  };

  const heartbeat = (input: TelegramWorkerHeartbeatInput): boolean => {
    const existing = workers.get(input.workerId);
    if (!existing) return false;
    if (existing.registrationGeneration !== input.registrationGeneration) {
      return false;
    }
    if (existing.runtimeGeneration !== input.runtimeGeneration) return false;
    workers.set(input.workerId, {
      ...existing,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      state: input.state ?? "ready",
      lastSeenMs: input.nowMs ?? Date.now(),
    });
    return true;
  };

  const unregister = (input: {
    workerId: string;
    registrationGeneration: string;
  }): boolean => {
    const existing = workers.get(input.workerId);
    if (!existing) return false;
    if (existing.registrationGeneration !== input.registrationGeneration) {
      return false;
    }
    workers.delete(input.workerId);
    options.onChange?.();
    return true;
  };

  const isCurrent = (
    workerId: string,
    registrationGeneration: string,
  ): boolean => workers.get(workerId)?.registrationGeneration === registrationGeneration;

  const markStale = (
    nowMs: number,
    graceMs: number,
  ): readonly TelegramWorkerView[] => {
    const changed: TelegramWorkerView[] = [];
    for (const [workerId, existing] of workers) {
      if (existing.state === "offline") continue;
      if (nowMs - existing.lastSeenMs <= graceMs) continue;
      const next: TelegramWorkerView = { ...existing, state: "offline" };
      workers.set(workerId, next);
      changed.push(next);
    }
    if (changed.length > 0) options.onChange?.();
    return changed;
  };

  const serialize = (): readonly TelegramWorkerSnapshot[] =>
    [...workers.values()].map((worker) => ({
      workerId: worker.workerId,
      kind: worker.kind,
      pid: worker.pid,
      processBirthId: worker.processBirthId,
      runtimeGeneration: worker.runtimeGeneration,
      cwd: worker.cwd,
      sessionId: worker.sessionId,
      connectedAtMs: worker.connectedAtMs,
      lastSeenMs: worker.lastSeenMs,
      ...(worker.protocol ? { protocol: worker.protocol } : {}),
      capabilities: [...worker.capabilities],
    }));

  const restore = (snapshots: readonly TelegramWorkerSnapshot[]): void => {
    for (const snapshot of snapshots) {
      if (workers.size >= TELEGRAM_WORKER_REGISTRY_CAPACITY) return;
      if (
        !snapshot ||
        !isValidWorkerId(snapshot.workerId) ||
        !isSafeInteger(snapshot.pid) ||
        !isValidWorkerId(snapshot.processBirthId) ||
        !Number.isSafeInteger(snapshot.runtimeGeneration)
      ) {
        continue;
      }
      // Restored workers are hints only: they stay offline until they actively
      // re-register, so a dead process cannot be treated as live routing truth.
      workers.set(snapshot.workerId, {
        workerId: snapshot.workerId,
        kind: snapshot.kind === "managed" ? "managed" : "attached",
        pid: snapshot.pid,
        processBirthId: snapshot.processBirthId,
        runtimeGeneration: snapshot.runtimeGeneration,
        cwd: typeof snapshot.cwd === "string" ? snapshot.cwd : "",
        sessionId: typeof snapshot.sessionId === "string" ? snapshot.sessionId : "",
        registrationGeneration: randomUUID(),
        connectedAtMs: snapshot.connectedAtMs,
        lastSeenMs: snapshot.lastSeenMs,
        state: "offline",
        ...(snapshot.protocol ? { protocol: snapshot.protocol } : {}),
        capabilities: [...(snapshot.capabilities ?? [])],
      });
    }
  };

  return {
    register,
    heartbeat,
    unregister,
    isCurrent,
    get: (workerId) => workers.get(workerId),
    list: () => [...workers.values()],
    markStale,
    serialize,
    restore,
    clear: () => workers.clear(),
  };
}
