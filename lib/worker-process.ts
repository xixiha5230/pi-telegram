/**
 * Node managed-worker process adapter
 * Zones: daemon control plane, process boundary
 * Owns the only place the daemon spawns an OS process for a managed Pi worker.
 */

import { spawn } from "node:child_process";
import type {
  TelegramManagedProcess,
  TelegramManagedProcessHandlers,
} from "./supervisor.ts";
import type { TelegramWorkerLaunchPlan } from "./worker-spec.ts";

export type TelegramWorkerSpawnPort = (
  plan: TelegramWorkerLaunchPlan,
  handlers: TelegramManagedProcessHandlers,
) => TelegramManagedProcess;

/**
 * Pi session-descriptor variables injected by the running Pi process into its
 * children (`docs/environment-variables.md`). They describe the *parent's*
 * session, model, and reasoning level, never a managed worker's own intent, so
 * a spawned worker must start from a clean session and resolve its own
 * configuration, model, and auth exactly like a freshly started terminal Pi.
 */
const INHERITED_SESSION_ENV_KEYS = [
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

/**
 * Sanitize the daemon environment for a managed worker: the worker must resolve
 * its own session and model, so the daemon's Pi session descriptors are dropped
 * while the operator's real configuration and credentials are preserved.
 */
export function telegramWorkerSpawnEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of INHERITED_SESSION_ENV_KEYS) delete env[key];
  return env;
}

export function createNodeWorkerSpawnPort(): TelegramWorkerSpawnPort {
  return (plan, handlers) => {
    const child = spawn(plan.command, [...plan.args], {
      cwd: plan.cwd,
      env: { ...telegramWorkerSpawnEnvironment(), ...plan.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => handlers.onData(String(chunk)));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) handlers.onError(new Error(text));
    });
    child.on("error", (error) => handlers.onError(error));
    child.on("exit", (code) => handlers.onExit(code));
    return {
      pid: child.pid ?? 0,
      write: (line) => {
        child.stdin?.write(line);
      },
      kill: (signal) => {
        child.kill(signal);
      },
    };
  };
}
