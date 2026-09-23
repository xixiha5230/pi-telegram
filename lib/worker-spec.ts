/**
 * Daemon worker launch specs
 * Zones: daemon control plane, supervisor boundary
 * Owns the operator-controlled launch allowlist for managed Pi workers: named
 * specs with an absolute, realpath-resolved, root-constrained cwd and a fixed
 * argument shape. Telegram only ever selects a spec by name; an update never
 * supplies argv, cwd, env, or command text.
 */

export type TelegramWorkerTrust = "approve" | "never";

export type TelegramWorkerRestart = "on-failure" | "never";

export type TelegramWorkerSession =
  | "latest"
  | "new"
  | { id: string };

export interface TelegramWorkerLaunchSpec {
  name: string;
  cwd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  session: TelegramWorkerSession;
  trust: TelegramWorkerTrust;
  restart: TelegramWorkerRestart;
  autoStart: boolean;
}

export const TELEGRAM_WORKER_SPEC_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;

export type TelegramWorkerSpecReason =
  | "invalid-shape"
  | "invalid-name"
  | "relative-cwd"
  | "cwd-outside-roots"
  | "cwd-not-directory"
  | "invalid-trust"
  | "invalid-restart"
  | "invalid-session"
  | "invalid-args"
  | "invalid-env";

export type TelegramWorkerSpecResult =
  | { ok: true; spec: TelegramWorkerLaunchSpec }
  | { ok: false; reason: TelegramWorkerSpecReason };

export interface TelegramWorkerSpecResolutionPorts {
  resolveRealPath: (path: string) => string;
  isDirectory: (path: string) => boolean;
}

export interface TelegramWorkerSpecValidationOptions {
  allowedRoots: readonly string[];
  ports: TelegramWorkerSpecResolutionPorts;
}

function isInsideRoot(cwd: string, root: string): boolean {
  if (cwd === root) return true;
  return cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function parseSession(value: unknown): TelegramWorkerSession | undefined {
  if (value === undefined) return "latest";
  if (value === "latest" || value === "new") return value;
  if (typeof value === "string" && value.length > 0 && value.length <= 512) {
    return { id: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0 && id.length <= 512) return { id };
  }
  return undefined;
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

function parseEnv(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string") {
      return undefined;
    }
    env[key] = entry;
  }
  return env;
}

export function validateTelegramWorkerLaunchSpec(
  input: unknown,
  options: TelegramWorkerSpecValidationOptions,
): TelegramWorkerSpecResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid-shape" };
  }
  const record = input as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !TELEGRAM_WORKER_SPEC_NAME_PATTERN.test(name)) {
    return { ok: false, reason: "invalid-name" };
  }
  const cwd = record.cwd;
  if (typeof cwd !== "string" || !cwd.startsWith("/")) {
    return { ok: false, reason: "relative-cwd" };
  }
  const args = parseStringArray(record.args);
  if (args === undefined) return { ok: false, reason: "invalid-args" };
  const env = parseEnv(record.env);
  if (env === undefined) return { ok: false, reason: "invalid-env" };
  const session = parseSession(record.session);
  if (session === undefined) return { ok: false, reason: "invalid-session" };
  const trust = record.trust ?? "approve";
  if (trust !== "approve" && trust !== "never") {
    return { ok: false, reason: "invalid-trust" };
  }
  const restart = record.restart ?? "on-failure";
  if (restart !== "on-failure" && restart !== "never") {
    return { ok: false, reason: "invalid-restart" };
  }
  const autoStart = record.autoStart ?? false;
  if (typeof autoStart !== "boolean") return { ok: false, reason: "invalid-shape" };

  let resolvedCwd: string;
  try {
    resolvedCwd = options.ports.resolveRealPath(cwd);
  } catch {
    return { ok: false, reason: "cwd-not-directory" };
  }
  const roots = options.allowedRoots.map((root) => {
    try {
      return options.ports.resolveRealPath(root);
    } catch {
      return root;
    }
  });
  if (!roots.some((root) => isInsideRoot(resolvedCwd, root))) {
    return { ok: false, reason: "cwd-outside-roots" };
  }
  let isDirectory = false;
  try {
    isDirectory = options.ports.isDirectory(resolvedCwd);
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { ok: false, reason: "cwd-not-directory" };

  return {
    ok: true,
    spec: {
      name,
      cwd: resolvedCwd,
      args,
      env,
      session,
      trust,
      restart,
      autoStart,
    },
  };
}

/**
 * Stable identity for a managed worker launched from a directory. It is the same
 * value for every restart, so persisted routes and Thread bindings survive.
 */
export function resolveTelegramWorkerIdFromPath(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "worker";
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "worker"
  );
}

export interface TelegramWorkerLaunchPlan {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface TelegramWorkerLaunchPlanDeps {
  executable: string;
}

/**
 * Build the process invocation for one managed worker.
 *
 * The daemon holds the worker's RPC channel and relays Telegram for it, so the
 * worker is never told about the daemon endpoint and never receives a bus
 * credential: a managed worker must not register as a follower. Extension loading
 * is intentionally NOT restricted, so the worker inherits the operator's normal
 * configuration (providers, models, settings, packages) exactly like a terminal Pi,
 * and `--approve` only settles project trust for non-interactive startup.
 */
export function planTelegramWorkerLaunch(
  spec: TelegramWorkerLaunchSpec,
  deps: TelegramWorkerLaunchPlanDeps,
): TelegramWorkerLaunchPlan {
  const args = [
    "--mode",
    "rpc",
    ...(spec.trust === "approve" ? ["--approve"] : []),
    ...(typeof spec.session === "object" ? ["--session", spec.session.id] : []),
    ...spec.args,
  ];
  return {
    command: deps.executable,
    args,
    cwd: spec.cwd,
    env: {
      ...spec.env,
      // One manual-follower identity per managed worker. Without this every worker the
      // daemon launches inherits the daemon's own parent-derived identity, so the
      // leader treats each new worker as a successor of the others and hands the same
      // Telegram Thread between them.
      PI_TELEGRAM_FOLLOWER_OWNER_ID: `worker:${spec.name}`,
    },
  };
}
