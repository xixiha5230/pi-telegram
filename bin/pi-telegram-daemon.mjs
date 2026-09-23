#!/usr/bin/env node
/**
 * pi-telegram-daemon CLI
 * Zones: daemon control plane
 * Thin executable wrapper around the compiled daemon entry.
 */

import { main } from "../dist/lib/daemon.js";

main(process.argv.slice(2)).catch((error) => {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
