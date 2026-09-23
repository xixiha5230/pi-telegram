/**
 * Pi extension host adapter
 * Zones: pi agent sdk boundary, host boundary
 * Owns construction of the bridge host contract from a live Pi extension API.
 * This is the only place that adapts the Pi SDK into the host contract.
 */

import * as Pi from "./pi.ts";
import type { TelegramBridgeHost } from "./host.ts";

export function createPiBridgeHost(api: Pi.ExtensionAPI): TelegramBridgeHost {
  return {
    api,
    ports: Pi.createExtensionApiRuntimePorts(api),
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
