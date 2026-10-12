#!/usr/bin/env node
/**
 * pi-telegram-daemon CLI
 * Zones: daemon control plane
 * Thin launcher for the built daemon entry. The daemon owns Telegram transport,
 * the direct Bot API, the inbound journal, the worker registry, routing, and the
 * managed-worker supervisor.
 *
 * The extension's `peerDependencies` lists every host-provided package the bridge
 * uses, but `@sinclair/typebox` is a schema builder the built modules need at
 * load time and npm may prune it after a later install. The build ships a copy
 * under `dist/node_modules`, so this launcher never installs, symlinks, or probes
 * for a missing peer; it only imports the entry and runs `main`.
 */

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const daemonEntry = join(packageRoot, "dist", "lib", "daemon.js");

let daemon;
try {
  daemon = await import(pathToFileURL(daemonEntry).href);
} catch (error) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
}

if (typeof daemon.main !== "function") {
  process.stderr.write(
    `Expected a \`main\` function export from ${daemonEntry}; got ${typeof daemon.main}.\n`,
  );
  process.exit(1);
}

daemon.main(process.argv.slice(2)).catch((error) => {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
