#!/usr/bin/env node
/**
 * pi-telegram-daemon CLI
 * Zones: daemon control plane
 * Standalone daemon bootstrap. Resolves every host-provided peer declared in
 * `peerDependencies` (npm auto-installs can be pruned by a later
 * `npm install` of an unrelated package, leaving the standalone daemon unable
 * to start). When a peer is missing, vendor it into a daemon-private
 * `node_modules` under the agent tmp dir, then expose it to ESM resolution
 * by symlinking it into the installed package's own `node_modules`.
 *
 * The symlink is created at runtime by this separate daemon process; it is
 * not declared in `dependencies`, so the host extension loader's contract that
 * host-provided packages must be `peerDependencies` with a `*` range remains
 * satisfied. The loader inspects `package.json`, not the presence of vendored
 * copies in `node_modules`.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const pkgJsonPath = join(packageRoot, "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const peerDependencies = pkg.peerDependencies ?? {};

const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const vendorRoot = join(piAgentDir, "tmp", "telegram", "daemon-vendor");
const vendorNodeModules = join(vendorRoot, "node_modules");
const packageNodeModules = join(packageRoot, "node_modules");
const daemonEntry = join(packageRoot, "dist", "lib", "daemon.js");

const requireFromRoot = createRequire(join(packageRoot, "noop.cjs"));

function isPeerResolvableFromRoot(peer) {
  try {
    return requireFromRoot.resolve(peer);
  } catch {
    return undefined;
  }
}

function peerLinkPath(peer) {
  return join(packageNodeModules, ...peer.split("/"));
}

const missingPeers = Object.keys(peerDependencies).filter((peer) => {
  if (existsSync(peerLinkPath(peer))) return false;
  if (existsSync(join(vendorNodeModules, ...peer.split("/")))) {
    // vendor has it; expose via symlink below
    return true;
  }
  return isPeerResolvableFromRoot(peer) === undefined;
});

if (missingPeers.length > 0) {
  const toInstall = missingPeers.filter(
    (peer) => !existsSync(join(vendorNodeModules, ...peer.split("/"))),
  );
  if (toInstall.length > 0) {
    try {
      mkdirSync(vendorRoot, { recursive: true });
    } catch {
      // best-effort; `npm install` below will surface the real failure
    }
    const specs = toInstall.map(
      (peer) => `${peer}@${peerDependencies[peer] ?? "*"}`,
    );
    const result = spawnSync(
      "npm",
      [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--prefix",
        vendorRoot,
        ...specs,
      ],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      process.stderr.write(
        `Failed to install daemon peers (${specs.join(" ")}) into ${vendorRoot}.\n`,
      );
      process.exit(result.status ?? 1);
    }
  }
  // Expose vendored peers to the child module's ESM resolver by symlinking
  // them into the installed package's own `node_modules`. ESM resolution walks
  // adjacent `node_modules` upward and will find them there.
  mkdirSync(packageNodeModules, { recursive: true });
  for (const peer of missingPeers) {
    const linkPath = peerLinkPath(peer);
    if (existsSync(linkPath)) continue;
    const vendorPath = join(vendorNodeModules, ...peer.split("/"));
    const vendorPathWithSep =
      vendorPath + (vendorPath.endsWith(sep) ? "" : sep);
    mkdirSync(dirname(linkPath), { recursive: true });
    try {
      symlinkSync(vendorPathWithSep, linkPath, "dir");
    } catch (error) {
      process.stderr.write(
        `Failed to expose vendored peer ${peer} at ${linkPath} -> ${vendorPath}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      process.exit(1);
    }
  }
}

const daemon = await import(pathToFileURL(daemonEntry).href);
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
