/**
 * Pi extension host adapter
 * Zones: pi agent sdk boundary, host boundary
 * Owns construction of the bridge host contract from a live Pi extension API.
 * This is the only place that adapts the Pi SDK into the host contract.
 */

import * as Pi from "./pi.ts";
import { TELEGRAM_TOKENLESS_WORKER_ENV } from "./config.ts";
import type { TelegramWorkerControlCommand } from "./worker-control-protocol.ts";
import { TELEGRAM_DAEMON_WORKER_ENV } from "./worker-spec.ts";
import type { TelegramBridgeHost } from "./host.ts";

async function executePiWorkerControl(
  api: Pi.ExtensionAPI,
  command: TelegramWorkerControlCommand,
  ctx: Pi.ExtensionContext,
): Promise<unknown> {
  switch (command.type) {
    case "prompt":
      await api.sendUserMessage(command.message, {
        ...(command.deliverAs ? { deliverAs: command.deliverAs } : {}),
      });
      return { accepted: true };
    case "steer":
      await api.sendUserMessage(command.message, { deliverAs: "steer" });
      return { accepted: true };
    case "abort":
      ctx.abort();
      return { accepted: true };
    case "compact":
      ctx.compact();
      return { accepted: true };
    case "set_model": {
      const model = ctx.modelRegistry.find(command.provider, command.modelId);
      if (!model) throw new Error("Requested Pi model is unavailable.");
      const changed = await api.setModel(model);
      if (!changed) throw new Error("Pi rejected the requested model.");
      return { accepted: true };
    }
    case "set_thinking_level":
      api.setThinkingLevel(
        command.level as Parameters<typeof api.setThinkingLevel>[0],
      );
      return { accepted: true };
    case "get_state":
      return {
        idle: ctx.isIdle(),
        hasPendingMessages: ctx.hasPendingMessages(),
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        model: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };
    case "clear_queue":
    case "new_session":
    case "switch_session":
      throw new Error(
        `Attached worker does not expose ${command.type} through ExtensionContext.`,
      );
  }
}

export function createPiWorkerControlHandler(
  api: Pi.ExtensionAPI,
): TelegramBridgeHost["workerControl"] {
  return (command, ctx) => executePiWorkerControl(api, command, ctx);
}

export function createPiBridgeHost(
  api: Pi.ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
): TelegramBridgeHost {
  // A daemon-managed worker is permanently non-leading. The daemon is the only
  // transport owner; without this a worker on the default `cluster.leader: "auto"`
  // could promote itself after a daemon crash and lock the restarted daemon out.
  const isDaemonWorker = env[TELEGRAM_DAEMON_WORKER_ENV]?.trim() === "1";
  // A tokenless attached worker holds no transport authority, so it must never lead.
  const isTokenlessWorker = env[TELEGRAM_TOKENLESS_WORKER_ENV]?.trim() === "1";
  return {
    api,
    ports: Pi.createExtensionApiRuntimePorts(api),
    workerControl: createPiWorkerControlHandler(api),
    ...(isDaemonWorker || isTokenlessWorker ? { canLead: () => false } : {}),
    helpers: {
      getExtensionContextModel: Pi.getExtensionContextModel,
      getExtensionContextCwd: Pi.getExtensionContextCwd,
      getExtensionContextSessionId: Pi.getExtensionContextSessionId,
      isExtensionContextIdle: Pi.isExtensionContextIdle,
      hasExtensionContextPendingMessages:
        Pi.hasExtensionContextPendingMessages,
      compactExtensionContext: Pi.compactExtensionContext,
      canStartPollingInExtensionContext: Pi.canStartPollingInExtensionContext,
      formatPollingStartBlockedByRunMode:
        Pi.formatPollingStartBlockedByRunMode,
      createSettingsManager: Pi.createSettingsManager,
    },
  };
}
