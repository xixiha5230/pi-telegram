/**
 * Pi-leader worker roster
 * Zones: telegram controls, multi-instance bus
 * Renders the `/workers` roster when a Pi instance owns transport instead of the
 * external daemon. It lists the current leader and live attached followers; it
 * does not manage process lifecycle, which stays daemon-only.
 */

import type { TelegramBusFollowerView } from "./bus.ts";
import type { TelegramLockState } from "./locks.ts";
import { createTelegramWorkerRegistry } from "./worker-registry.ts";
import {
  parseTelegramWorkerCommand,
  renderTelegramWorkerList,
  type TelegramWorkerControl,
  type TelegramWorkerControlResult,
} from "./worker-control.ts";

export interface TelegramPiLeaderRosterDeps {
  getLockState: () => TelegramLockState;
  listFollowers: () => readonly TelegramBusFollowerView[];
  getSessionId?: () => string | undefined;
}

const NOTICE_LIFECYCLE_UNAVAILABLE =
  "🚫 **Managed Pi worker lifecycle is daemon-only.**";

export function createPiLeaderWorkerControl(
  deps: TelegramPiLeaderRosterDeps,
): TelegramWorkerControl {
  const renderRoster = (): string => {
    const registry = createTelegramWorkerRegistry();
    const state = deps.getLockState();
    let leaderWorkerId: string | undefined;
    if (state.kind === "active-here") {
      const lock = state.lock;
      leaderWorkerId = lock.instanceId ?? `pid:${lock.pid}`;
      registry.register({
        workerId: leaderWorkerId,
        kind: "attached",
        pid: lock.pid,
        processBirthId: lock.instanceId ?? `pid:${lock.pid}`,
        runtimeGeneration: lock.runtimeGeneration ?? 0,
        cwd: lock.cwd ?? "",
        sessionId: deps.getSessionId?.() ?? "",
      });
    }
    for (const follower of deps.listFollowers()) {
      if (!Number.isSafeInteger(follower.pid) || (follower.pid ?? 0) <= 0) {
        continue;
      }
      registry.register({
        workerId: follower.instanceId,
        kind: "attached",
        pid: follower.pid as number,
        processBirthId: follower.processBirthId ?? follower.instanceId,
        runtimeGeneration: follower.sessionGeneration ?? 0,
        cwd: follower.cwd ?? "",
        sessionId: follower.sessionId ?? "",
      });
    }
    return renderTelegramWorkerList(registry.list(), [], {
      ...(leaderWorkerId ? { leaderWorkerId } : {}),
    });
  };

  return {
    parse: parseTelegramWorkerCommand,
    renderList: renderRoster,
    async execute(command): Promise<TelegramWorkerControlResult> {
      if (command.kind === "list") return { ok: true, html: renderRoster() };
      return { ok: false, html: NOTICE_LIFECYCLE_UNAVAILABLE };
    },
  };
}
