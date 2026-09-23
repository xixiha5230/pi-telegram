/**
 * Telegram bridge host boundary
 * Zones: host boundary, shared adapters
 * Owns the narrow host surface the bridge assembly requires so a Pi extension
 * host and an external daemon host can drive the same core runtimes without
 * either importing the other's runtime.
 */

import type * as Pi from "./pi.ts";

/**
 * Host-bound context helpers. Each host binds these to its own context type;
 * core runtimes only ever see the results, never the host SDK.
 */
export interface TelegramBridgeHostHelpers {
  getExtensionContextModel: typeof Pi.getExtensionContextModel;
  getExtensionContextCwd: typeof Pi.getExtensionContextCwd;
  getExtensionContextSessionId: typeof Pi.getExtensionContextSessionId;
  isExtensionContextIdle: typeof Pi.isExtensionContextIdle;
  hasExtensionContextPendingMessages: typeof Pi.hasExtensionContextPendingMessages;
  compactExtensionContext: typeof Pi.compactExtensionContext;
  canStartPollingInExtensionContext: typeof Pi.canStartPollingInExtensionContext;
  formatPollingStartBlockedByRunMode: typeof Pi.formatPollingStartBlockedByRunMode;
  createSettingsManager: typeof Pi.createSettingsManager;
}

/**
 * Everything the bridge assembly is allowed to borrow from its host.
 *
 * `api` remains the host registration surface (hooks, commands, tools, skills).
 * `ports` and `helpers` are the only host operations core runtimes consume.
 */
export interface TelegramBridgeHost {
  api: Pi.ExtensionAPI;
  ports: Pi.PiExtensionApiRuntimePorts;
  helpers: TelegramBridgeHostHelpers;
  /**
   * Overrides the cluster leadership policy for this host. The external daemon
   * sets this to always allow leadership, since `cluster.leader: "daemon"`
   * restricts election to the daemon itself.
   */
  canLead?: () => boolean;
}
