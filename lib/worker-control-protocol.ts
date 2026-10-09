/**
 * Worker control protocol
 * Zones: daemon control plane, worker IPC boundary
 * Owns the bounded, generation-fenced command contract shared by attached IPC
 * and managed RPC adapters. It excludes Telegram transport, arbitrary shell, and
 * process lifecycle; adapters own those effects at their respective boundaries.
 */

export type TelegramWorkerControlCommand =
  | { type: "prompt"; message: string; deliverAs?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "compact" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "new_session" }
  | { type: "switch_session"; sessionPath: string }
  | { type: "get_state" };

export type TelegramWorkerControlRejection =
  | "invalid-command"
  | "command-too-large"
  | "stale-generation"
  | "execution-failed";

export type TelegramWorkerControlResult =
  | { ok: true; result?: unknown }
  | { ok: false; reason: TelegramWorkerControlRejection; message: string };

const MAX_MESSAGE_LENGTH = 200_000;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 256;
const MAX_SESSION_PATH_LENGTH = 4_096;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isSlashCommand(value: string): boolean {
  return /^\s*\/[A-Za-z]/u.test(value);
}

/** Parse untrusted wire data into the explicit command allowlist. */
export function parseTelegramWorkerControlCommand(
  value: unknown,
): TelegramWorkerControlCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "prompt":
      if (!boundedString(record.message, MAX_MESSAGE_LENGTH) || isSlashCommand(record.message)) {
        return undefined;
      }
      return {
        type: "prompt",
        message: record.message,
        ...(record.deliverAs === "steer" || record.deliverAs === "followUp"
          ? { deliverAs: record.deliverAs }
          : {}),
      };
    case "steer":
      return boundedString(record.message, MAX_MESSAGE_LENGTH) && !isSlashCommand(record.message)
        ? { type: "steer", message: record.message }
        : undefined;
    case "abort":
    case "clear_queue":
    case "compact":
    case "new_session":
    case "get_state":
      return { type: record.type };
    case "set_model":
      return boundedString(record.provider, MAX_PROVIDER_LENGTH) &&
        boundedString(record.modelId, MAX_MODEL_LENGTH)
        ? { type: "set_model", provider: record.provider, modelId: record.modelId }
        : undefined;
    case "set_thinking_level":
      return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        typeof record.level === "string" ? record.level : "",
      )
        ? { type: "set_thinking_level", level: record.level as string }
        : undefined;
    case "switch_session":
      return boundedString(record.sessionPath, MAX_SESSION_PATH_LENGTH) &&
        record.sessionPath.startsWith("/")
        ? { type: "switch_session", sessionPath: record.sessionPath }
        : undefined;
    default:
      return undefined;
  }
}

export interface TelegramWorkerControlEnvelope {
  kind: "worker.control";
  requestId: string;
  workerId: string;
  registrationGeneration: string;
  command: TelegramWorkerControlCommand;
}

export interface TelegramWorkerControlReply {
  kind: "worker.control.reply";
  requestId: string;
  workerId: string;
  registrationGeneration: string;
  result: TelegramWorkerControlResult;
}

export interface TelegramWorkerControlTarget {
  workerId: string;
  registrationGeneration: string;
}

/**
 * Validate the identity fence before an adapter invokes a host API. A stale
 * process generation must fail closed and must never reach the Pi context.
 */
export function authorizeTelegramWorkerControl(
  envelope: TelegramWorkerControlEnvelope,
  target: TelegramWorkerControlTarget | undefined,
): TelegramWorkerControlResult {
  if (!target || envelope.workerId !== target.workerId ||
      envelope.registrationGeneration !== target.registrationGeneration) {
    return {
      ok: false,
      reason: "stale-generation",
      message: "Worker control request belongs to a stale registration.",
    };
  }
  return { ok: true };
}

export interface TelegramWorkerControlExecutor {
  execute: (
    command: TelegramWorkerControlCommand,
  ) => Promise<unknown> | unknown;
}

/** Execute only an already-authorized, parsed command and normalize failures. */
export async function executeTelegramWorkerControl(
  envelope: TelegramWorkerControlEnvelope,
  target: TelegramWorkerControlTarget | undefined,
  executor: TelegramWorkerControlExecutor,
): Promise<TelegramWorkerControlReply> {
  const authorization = authorizeTelegramWorkerControl(envelope, target);
  const result = authorization.ok
    ? await Promise.resolve().then(() => executor.execute(envelope.command))
        .then((value) => ({ ok: true as const, result: value }))
        .catch((error) => ({
          ok: false as const,
          reason: "execution-failed" as const,
          message: error instanceof Error ? error.message : String(error),
        }))
    : authorization;
  return {
    kind: "worker.control.reply",
    requestId: envelope.requestId,
    workerId: envelope.workerId,
    registrationGeneration: envelope.registrationGeneration,
    result,
  };
}
