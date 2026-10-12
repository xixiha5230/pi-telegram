#!/usr/bin/env node
/**
 * pi-telegram-daemon CLI
 * Zones: daemon control plane
 * Standalone daemon bootstrap. The extension's `peerDependencies` lists every
 * host-provided package the extension bridge uses (`@earendil-works/pi-...`),
 * but the standalone daemon entry only needs the peers it actually imports at
 * runtime (notably `@sinclair/typebox`). npm auto-installs can also be pruned
 * by a later unrelated `npm install`, leaving the daemon unable to start.
 *
 * Rather than preemptively installing every peer (which fails for host-only
 * packages that the daemon does not import), this bootstrapper attempts the
 * dynamic import of the daemon entry, and on the first
 * `ERR_MODULE_NOT_FOUND` for a bare specifier it vendors that specific peer
 * into a daemon-private `node_modules` under the agent tmp dir and symlinks
 * it into the installed package's own `node_modules` so the child module's
 * ESM resolver finds it, then retries the import.
 *
 * The vendored copy is created at runtime by this separate daemon process, not
 * declared in `dependencies`, so the host extension loader's contract that
 * host-provided packages must be `peerDependencies` with a `*` range remains
 * satisfied.
 */

import { spawnSync } from "node:child_process";
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

function vendorRootFor(peer) {
  return join(vendorNodeModules, ...peer.split("/"));
}

function packageLinkFor(peer) {
  return join(packageNodeModules, ...peer.split("/"));
}

function ensureSymlink(peer) {
  const linkPath = packageLinkFor(peer);
  if (existsSync(linkPath)) return;
  const vendorPath = vendorRootFor(peer);
  const vendorPathWithSep = vendorPath + (vendorPath.endsWith(sep) ? "" : sep);
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

function installPeerToVendor(peer) {
  try {
    mkdirSync(vendorRoot, { recursive: true });
  } catch {
    // best-effort; npm install below will surface the real failure
  }
  const range = peerDependencies[peer] ?? "*";
  const result = spawnSync(
    "npm",
    [
      "install",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--prefix",
      vendorRoot,
      `${peer}@${range}`,
    ],
    { stdio: "inherit" },
  );
  return result.status === 0;
}

function vendorAndExposePeer(peer) {
  if (!existsSync(vendorRootFor(peer))) {
    if (!installPeerToVendor(peer)) return false;
  }
  ensureSymlink(peer);
  return true;
}

// Parse the missing bare specifier from an ERR_MODULE_NOT_FOUND. Handles
// scoped packages (`@scope/name`) and returns the top-level package (drops any
// sub-path, e.g. `@sinclair/typebox/value` -> `@sinclair/typebox`). Returns
// null for non-bare or non-module-not-found errors.
function missingBareSpecifierFromError(error) {
  if (!error || error.code !== "ERR_MODULE_NOT_FOUND") return null;
  const message = error.message ?? "";
  const match = message.match(/Cannot find package '([^']+)'/);
  if (!match) return null;
  const specifier = match[1];
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split("/")[0];
}

const maxRetries = Object.keys(peerDependencies).length + 1;
const attempted = new Set();
let daemon;
let lastError;
for (let i = 0; i < maxRetries; i++) {
  try {
    daemon = await import(pathToFileURL(daemonEntry).href);
    break;
  } catch (error) {
    const missing = missingBareSpecifierFromError(error);
    if (!missing || attempted.has(missing) || !peerDependencies[missing]) {
      lastError = error;
      break;
    }
    attempted.add(missing);
    if (!vendorAndExposePeer(missing)) {
      lastError = error;
      break;
    }
  }
}

if (!daemon) {
  const detail =
    lastError instanceof Error
      ? (lastError.stack ?? lastError.message)
      : String(lastError);
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
