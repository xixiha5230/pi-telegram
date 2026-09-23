/**
 * Telegram bridge Pi extension entry
 * Zones: telegram, pi agent, orchestration
 * Owns the Pi host adapter and installs Pi-facing registration on top of the
 * host-parameterized core assembly. The package entrypoint stays a thin re-export.
 */

import * as Bindings from "./bindings.ts";
import * as Pi from "./pi.ts";
import * as Skills from "./skills.ts";
import { createTelegramBridge } from "./bridge.ts";
import { createPiBridgeHost } from "./pi-host.ts";
import { createPiLeaderWorkerControl } from "./pi-worker-roster.ts";
import { registerTelegramWorkerCommands } from "./worker-commands.ts";

export default function (pi: Pi.ExtensionAPI): void {
  const host = createPiBridgeHost(pi);
  Skills.registerTelegramSkillDiscovery(host.api);
  const core = createTelegramBridge(host);
  Bindings.registerTelegramCommandsAndTools(core.commandRegistration);
  Bindings.registerTelegramLifecycleRuntimeHooks(core.lifecycleRegistration);
  // `/workers` works in both topologies. Here it serves the Pi-leader topology;
  // the external daemon registers its own data-backed control instead.
  registerTelegramWorkerCommands({
    control: createPiLeaderWorkerControl({
      getLockState: core.ports.lockRuntime.getState,
      listFollowers: core.ports.busFollowers.list,
      getSessionId: () =>
        core.ports.sessionContextStore.get()?.sessionManager?.getSessionId(),
    }),
    epoch: String(core.ports.lockRuntime.getOwnedLeaderEpoch() ?? "pi-leader"),
    api: core.ports.telegramApiRuntime,
    enabled: () => core.ports.lockRuntime.owns(),
    recordRuntimeEvent: core.ports.recordRuntimeEvent,
  });
}
