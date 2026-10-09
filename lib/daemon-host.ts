/**
 * External daemon host adapter
 * Zones: host boundary, daemon control plane
 * Owns the daemon-side implementation of the bridge host contract. The daemon
 * owns Telegram transport and routing but runs no Pi session, so Pi-facing
 * registration and Pi lifecycle surfaces are inert: the daemon never installs
 * the bridge registration bundles. Every cast to a Pi context type is confined
 * here and is documented; core runtimes only consume `ports` and `helpers`.
 */

import type * as Pi from "./pi.ts";
import type {
  TelegramBridgeHost,
  TelegramBridgeHostHelpers,
} from "./host.ts";

export interface TelegramDaemonHostOptions {
  /** Reserved for host-scoped configuration; the daemon context supplies cwd. */
  cwd?: string;
}

function createDaemonSettingsManager() {
  return {
    reload: async () => undefined,
    flush: async () => undefined,
    getEnabledModels: () => undefined,
    setEnabledModels: () => undefined,
  };
}

function createDaemonApiPorts(): Pi.PiExtensionApiRuntimePorts {
  return {
    sendUserMessage: async () => {
      throw new Error("The Telegram daemon does not run Pi turns directly.");
    },
    exec: async () => {
      throw new Error("The Telegram daemon does not execute Pi commands.");
    },
    getCommands: () => [],
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => undefined as never,
    getActiveTools: () => [],
    setActiveTools: () => undefined as never,
    setModel: () => undefined as never,
    registerCommand: () => undefined,
  };
}

function createDaemonHelpers(): TelegramBridgeHostHelpers {
  return {
    getExtensionContextModel: () => undefined as never,
    getExtensionContextCwd: (ctx) => (ctx as unknown as { cwd: string }).cwd,
    // The daemon has no Pi session; its workspace identity uses one stable
    // synthetic session id so leader-thread provisioning has a bounded value.
    getExtensionContextSessionId: (ctx) =>
      (ctx as unknown as { sessionManager?: { getSessionId(): string } })
        .sessionManager?.getSessionId() ?? "daemon",
    isExtensionContextIdle: () => true,
    hasExtensionContextPendingMessages: () => false,
    compactExtensionContext: async () => undefined as never,
    canStartPollingInExtensionContext: () => true,
    formatPollingStartBlockedByRunMode: () =>
      "Telegram polling is unavailable in the daemon host.",
    createSettingsManager: async () =>
      createDaemonSettingsManager() as never,
  };
}

export function createDaemonBridgeHost(
  _options: TelegramDaemonHostOptions = {},
): TelegramBridgeHost {
  return {
    // The daemon never installs the bridge registration bundles, so the raw
    // Pi extension API is never invoked. It exists only to satisfy the host
    // contract shape.
    api: {} as Pi.ExtensionAPI,
    ports: createDaemonApiPorts(),
    workerControl: async () => {
      throw new Error("The daemon host does not own a Pi worker context.");
    },
    helpers: createDaemonHelpers(),
    // The daemon is the only leader under `cluster.leader: "daemon"`.
    canLead: () => true,
  };
}
