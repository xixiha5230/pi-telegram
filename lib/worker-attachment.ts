/**
 * Telegram worker Thread attachment
 * Zones: daemon control plane, telegram routing
 * Owns the operator `/attach` and `/detach` Thread re-homing: it verifies the worker,
 * chat, and Thread before moving a worker's serve target through the authenticated
 * follower path, and remembers the previous Thread so detach can restore it. It never
 * spawns, probes, or kills processes; the daemon owns those mechanics.
 */

import type { TelegramRouteRegistry } from "./route-registry.ts";
import type { TelegramTarget } from "./target.ts";

export interface TelegramWorkerAttachmentFollower {
  target?: TelegramTarget;
  registrationGeneration?: string;
}

export interface TelegramWorkerAttachmentDeps {
  routes: Pick<TelegramRouteRegistry, "set" | "clear">;
  resolveFollower: (
    workerId: string,
  ) => TelegramWorkerAttachmentFollower | undefined;
  /** Re-home a live worker's serve target; returns false when the worker refuses. */
  replaceServeTarget: (input: {
    workerId: string;
    target: TelegramTarget & { threadId: number };
    oldTarget: TelegramTarget & { threadId: number };
  }) => Promise<boolean>;
  /** The daemon's own control thread, which must never serve a worker. */
  getDaemonTarget: () => TelegramTarget | undefined;
  epoch: string;
  /** Called after a durable attachment change worth persisting. */
  onChange?: () => void;
}

export interface TelegramWorkerAttachmentSnapshot {
  key: string;
  workerId: string;
  previousTarget: TelegramTarget & { threadId: number };
}

export interface TelegramWorkerAttachmentRuntime {
  attach: (input: {
    workerId: string;
    target: TelegramTarget;
  }) => Promise<{ ok: boolean; message: string }>;
  detach: (input: {
    target: TelegramTarget;
  }) => Promise<{ ok: boolean; message: string }>;
  serialize: () => readonly TelegramWorkerAttachmentSnapshot[];
  restore: (entries: readonly unknown[]) => void;
}

function attachmentKey(target: TelegramTarget): string {
  return `${target.chatId}:${target.threadId ?? 0}`;
}

function parseSnapshot(
  value: unknown,
): TelegramWorkerAttachmentSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as {
    key?: unknown;
    workerId?: unknown;
    previousTarget?: unknown;
  };
  const previous = record.previousTarget as
    | { chatId?: unknown; threadId?: unknown }
    | undefined;
  if (
    typeof record.key !== "string" ||
    typeof record.workerId !== "string" ||
    !previous ||
    !Number.isSafeInteger(previous.chatId) ||
    !Number.isSafeInteger(previous.threadId)
  ) {
    return undefined;
  }
  return {
    key: record.key,
    workerId: record.workerId,
    previousTarget: {
      chatId: previous.chatId as number,
      threadId: previous.threadId as number,
    },
  };
}

export function createTelegramWorkerAttachmentRuntime(
  deps: TelegramWorkerAttachmentDeps,
): TelegramWorkerAttachmentRuntime {
  const attachments = new Map<
    string,
    { workerId: string; previousTarget: TelegramTarget & { threadId: number } }
  >();
  return {
    async attach(input) {
      const follower = deps.resolveFollower(input.workerId);
      const workerTarget = follower?.target;
      const threadId = input.target.threadId;
      if (
        !follower?.registrationGeneration ||
        !workerTarget ||
        workerTarget.threadId === undefined
      ) {
        return { ok: false, message: "That Pi worker has no live Thread to move." };
      }
      if (threadId === undefined) {
        return { ok: false, message: "Attach a forum topic, not the General thread." };
      }
      const daemonTarget = deps.getDaemonTarget();
      if (
        daemonTarget &&
        daemonTarget.chatId === input.target.chatId &&
        daemonTarget.threadId === threadId
      ) {
        return { ok: false, message: "The daemon control thread cannot serve a worker." };
      }
      if (input.target.chatId !== workerTarget.chatId) {
        return { ok: false, message: "A worker can only move within its own chat." };
      }
      const target = { chatId: input.target.chatId, threadId };
      if (threadId === workerTarget.threadId) {
        deps.routes.set({
          target,
          workerId: input.workerId,
          registrationGeneration: follower.registrationGeneration,
          epoch: deps.epoch,
        });
        return { ok: true, message: "This thread already serves that worker." };
      }
      const replaced = await deps.replaceServeTarget({
        workerId: input.workerId,
        target,
        oldTarget: {
          chatId: workerTarget.chatId,
          threadId: workerTarget.threadId,
        },
      });
      if (!replaced) {
        return { ok: false, message: "The Pi worker refused the Thread move." };
      }
      attachments.set(attachmentKey(target), {
        workerId: input.workerId,
        previousTarget: {
          chatId: workerTarget.chatId,
          threadId: workerTarget.threadId,
        },
      });
      deps.routes.set({
        target,
        workerId: input.workerId,
        registrationGeneration: follower.registrationGeneration,
        epoch: deps.epoch,
      });
      deps.onChange?.();
      return { ok: true, message: "moved" };
    },
    async detach(input) {
      const threadId = input.target.threadId;
      if (threadId === undefined) {
        return { ok: false, message: "This thread had no attached Pi worker." };
      }
      const key = attachmentKey(input.target);
      const record = attachments.get(key);
      if (!record) {
        return { ok: false, message: "This thread had no attached Pi worker." };
      }
      const follower = deps.resolveFollower(record.workerId);
      const currentTarget = follower?.target;
      if (!currentTarget || currentTarget.threadId === undefined) {
        // Without a live worker there is no exact Thread to move back from; keep the
        // record so a later detach can still restore it.
        return { ok: false, message: "The Pi worker is not live to move back." };
      }
      const replaced = await deps.replaceServeTarget({
        workerId: record.workerId,
        target: record.previousTarget,
        oldTarget: {
          chatId: currentTarget.chatId,
          threadId: currentTarget.threadId,
        },
      });
      if (!replaced) {
        return { ok: false, message: "The Pi worker could not be moved back." };
      }
      attachments.delete(key);
      deps.routes.clear({ target: { chatId: input.target.chatId, threadId }, epoch: deps.epoch });
      deps.onChange?.();
      return { ok: true, message: "moved" };
    },
    serialize: () =>
      [...attachments.entries()].map(([key, value]) => ({ key, ...value })),
    restore(entries) {
      for (const entry of entries) {
        const snapshot = parseSnapshot(entry);
        if (snapshot) {
          attachments.set(snapshot.key, {
            workerId: snapshot.workerId,
            previousTarget: snapshot.previousTarget,
          });
        }
      }
    },
  };
}
