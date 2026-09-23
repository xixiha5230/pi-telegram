/**
 * Telegram daemon route registry
 * Zones: daemon control plane, routing
 * Owns the mutable `target -> workerId` binding the daemon uses to deliver inbound
 * updates and Telegram UI actions. Every mutation is fenced by the daemon epoch so
 * a replaced daemon generation cannot publish, replace, or clear routes.
 */

import { getTelegramTargetKey, type TelegramTarget } from "./target.ts";

export interface TelegramRouteView {
  target: TelegramTarget;
  workerId: string;
  registrationGeneration: string;
  epoch: string;
  updatedAtMs: number;
}

export type TelegramRouteSetReason =
  | "no-epoch"
  | "stale-epoch"
  | "invalid-target"
  | "invalid-worker";

export type TelegramRouteSetResult =
  | { ok: true; route: TelegramRouteView }
  | { ok: false; reason: TelegramRouteSetReason };

export interface TelegramRouteSnapshot {
  target: TelegramTarget;
  workerId: string;
  registrationGeneration: string;
  updatedAtMs: number;
}

export interface TelegramRouteRegistryOptions {
  /** Called after a route mutation worth persisting. */
  onChange?: () => void;
}

export interface TelegramRouteRegistry {
  adoptEpoch: (epoch: string) => void;
  getEpoch: () => string | undefined;
  set: (input: {
    target: TelegramTarget;
    workerId: string;
    registrationGeneration: string;
    epoch: string;
    nowMs?: number;
  }) => TelegramRouteSetResult;
  clear: (input: { target: TelegramTarget; epoch: string }) => boolean;
  clearWorker: (input: { workerId: string; epoch: string }) => number;
  resolve: (target: TelegramTarget) => TelegramRouteView | undefined;
  isBound: (target: TelegramTarget) => boolean;
  list: () => readonly TelegramRouteView[];
  serialize: () => readonly TelegramRouteSnapshot[];
  restore: (snapshots: readonly TelegramRouteSnapshot[]) => void;
  reset: () => void;
}

function isValidTarget(target: TelegramTarget): boolean {
  if (!Number.isSafeInteger(target.chatId) || target.chatId === 0) return false;
  if (target.threadId === undefined) return true;
  return Number.isSafeInteger(target.threadId) && target.threadId > 0;
}

/** Route keys and snapshots carry only the canonical target shape. */
function normalizeTarget(target: TelegramTarget): TelegramTarget {
  return target.threadId === undefined
    ? { chatId: target.chatId }
    : { chatId: target.chatId, threadId: target.threadId };
}

function isValidWorkerId(workerId: string): boolean {
  return workerId.length > 0 && workerId.length <= 256;
}

export function createTelegramRouteRegistry(
  options: TelegramRouteRegistryOptions = {},
): TelegramRouteRegistry {
  const routes = new Map<string, TelegramRouteView>();
  let epoch: string | undefined;

  const requireEpoch = (candidate: string): TelegramRouteSetReason | undefined => {
    if (!epoch) return "no-epoch";
    if (candidate !== epoch) return "stale-epoch";
    return undefined;
  };

  return {
    adoptEpoch(nextEpoch) {
      epoch = nextEpoch;
    },
    getEpoch: () => epoch,
    set(input) {
      const epochError = requireEpoch(input.epoch);
      if (epochError) return { ok: false, reason: epochError };
      if (!isValidTarget(input.target)) {
        return { ok: false, reason: "invalid-target" };
      }
      if (!isValidWorkerId(input.workerId)) {
        return { ok: false, reason: "invalid-worker" };
      }
      const target = normalizeTarget(input.target);
      const route: TelegramRouteView = {
        target,
        workerId: input.workerId,
        registrationGeneration: input.registrationGeneration,
        epoch: input.epoch,
        updatedAtMs: input.nowMs ?? Date.now(),
      };
      routes.set(getTelegramTargetKey(target), route);
      options.onChange?.();
      return { ok: true, route };
    },
    clear(input) {
      if (requireEpoch(input.epoch)) return false;
      const cleared = routes.delete(getTelegramTargetKey(input.target));
      if (cleared) options.onChange?.();
      return cleared;
    },
    clearWorker(input) {
      if (requireEpoch(input.epoch)) return 0;
      let removed = 0;
      for (const [key, route] of routes) {
        if (route.workerId !== input.workerId) continue;
        routes.delete(key);
        removed += 1;
      }
      if (removed > 0) options.onChange?.();
      return removed;
    },
    resolve: (target) => routes.get(getTelegramTargetKey(target)),
    isBound: (target) => routes.has(getTelegramTargetKey(target)),
    list: () => [...routes.values()],
    serialize: () =>
      [...routes.values()].map((route) => ({
        target: normalizeTarget(route.target),
        workerId: route.workerId,
        registrationGeneration: route.registrationGeneration,
        updatedAtMs: route.updatedAtMs,
      })),
    restore(snapshots) {
      // Routes are daemon-owned and adopt the current epoch: a restarted
      // daemon generation inherits its own persisted routing table.
      if (!epoch) return;
      for (const snapshot of snapshots) {
        if (!snapshot || !isValidTarget(snapshot.target)) continue;
        if (!isValidWorkerId(snapshot.workerId)) continue;
        routes.set(getTelegramTargetKey(snapshot.target), {
          target: normalizeTarget(snapshot.target),
          workerId: snapshot.workerId,
          registrationGeneration: snapshot.registrationGeneration,
          epoch,
          updatedAtMs: snapshot.updatedAtMs,
        });
      }
    },
    reset: () => routes.clear(),
  };
}
