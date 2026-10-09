/**
 * Managed Pi extension-UI bridge
 * Zones: daemon control plane, Telegram UI orchestration
 * Owns bounded one-shot Telegram dialogs for `pi --mode rpc` extension UI requests.
 * It excludes arbitrary command execution, durable work admission, and direct Pi
 * process control; the supervisor supplies the fenced response callback.
 */

import { randomBytes } from "node:crypto";
import { getTelegramUpdateHandlerRegistry } from "./updates.ts";
import type { TelegramTarget } from "./target.ts";

export type TelegramManagedWorkerUiReply =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export type TelegramManagedWorkerUiResponder = (
  reply: TelegramManagedWorkerUiReply,
) => void;

export interface TelegramManagedWorkerUiRoute {
  target: TelegramTarget;
  registrationGeneration: string;
}

const CALLBACK_PREFIX = "ptui:";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_DIALOGS = 32;
const MAX_OPTIONS = 60;
const MAX_TEXT_LENGTH = 4_000;
const MAX_ID_LENGTH = 24;

interface Dialog {
  id: string;
  workerId: string;
  generation: string;
  target: TelegramTarget;
  method: "select" | "confirm" | "input" | "editor";
  options?: readonly string[];
  respond: TelegramManagedWorkerUiResponder;
  messageId?: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface TelegramManagedWorkerUiBridge {
  handleRequest: (
    workerId: string,
    request: unknown,
    respond: TelegramManagedWorkerUiResponder,
  ) => void;
  /** Pre-routing verdict for one Telegram update. */
  handleUpdate: (update: unknown) => Promise<"pass" | "consume">;
  start: () => () => void;
  cancelWorker: (workerId: string) => void;
  dispose: () => void;
  pendingCount: () => number;
}

export interface TelegramManagedWorkerUiBridgeDeps {
  api: {
    call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  /** Live route for a managed worker spec, or undefined when unbound/offline. */
  resolveRoute: (workerId: string) => TelegramManagedWorkerUiRoute | undefined;
  getAllowedUserId: () => number | undefined;
  timeoutMs?: number;
  createId?: () => string;
  recordEvent?: (error: unknown, details: Record<string, unknown>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function readTarget(value: unknown): TelegramTarget | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.chat) ||
    !Number.isSafeInteger(value.chat.id)
  ) {
    return undefined;
  }
  const threadId = value.message_thread_id;
  return {
    chatId: value.chat.id as number,
    ...(Number.isSafeInteger(threadId) ? { threadId: threadId as number } : {}),
  };
}

function targetKey(target: TelegramTarget): string {
  return `${target.chatId}:${target.threadId ?? "classic"}`;
}

function readMessageId(value: unknown): number | undefined {
  return isRecord(value) && Number.isSafeInteger(value.message_id)
    ? (value.message_id as number)
    : undefined;
}

/** Validate an untrusted RPC event into the bounded dialog allowlist. */
export function parseTelegramManagedWorkerUiRequest(
  value: unknown,
):
  | {
      id: string;
      method: "select" | "confirm" | "input" | "editor";
      title: string;
      message?: string;
      placeholder?: string;
      prefill?: string;
      options?: readonly string[];
    }
  | undefined {
  if (
    !isRecord(value) ||
    value.type !== "extension_ui_request" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    typeof value.method !== "string"
  ) {
    return undefined;
  }
  const title =
    typeof value.title === "string" && value.title.trim()
      ? value.title.slice(0, MAX_TEXT_LENGTH)
      : "Pi needs input";
  switch (value.method) {
    case "select": {
      const options = Array.isArray(value.options)
        ? value.options
            .filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.length <= MAX_TEXT_LENGTH,
            )
            .slice(0, MAX_OPTIONS)
        : [];
      return options.length > 0
        ? { id: value.id, method: "select", title, options }
        : undefined;
    }
    case "confirm":
      return {
        id: value.id,
        method: "confirm",
        title,
        ...(typeof value.message === "string"
          ? { message: value.message.slice(0, MAX_TEXT_LENGTH) }
          : {}),
      };
    case "input":
      return {
        id: value.id,
        method: "input",
        title,
        ...(typeof value.placeholder === "string"
          ? { placeholder: value.placeholder.slice(0, MAX_TEXT_LENGTH) }
          : {}),
      };
    case "editor":
      return {
        id: value.id,
        method: "editor",
        title,
        ...(typeof value.prefill === "string"
          ? { prefill: value.prefill.slice(0, MAX_TEXT_LENGTH) }
          : {}),
      };
    default:
      return undefined;
  }
}

export function createTelegramManagedWorkerUiBridge(
  deps: TelegramManagedWorkerUiBridgeDeps,
): TelegramManagedWorkerUiBridge {
  const dialogs = new Map<string, Dialog>();
  const createId =
    deps.createId ?? (() => randomBytes(9).toString("base64url"));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const respondOnce = (
    dialog: Dialog,
    reply: TelegramManagedWorkerUiReply,
  ): void => {
    if (!dialogs.delete(dialog.id)) return;
    clearTimeout(dialog.timer);
    try {
      dialog.respond(reply);
    } catch (error) {
      deps.recordEvent?.(error, {
        phase: "worker-ui-response",
        workerId: dialog.workerId,
      });
    }
  };

  const removePrompt = async (dialog: Dialog): Promise<void> => {
    if (dialog.messageId === undefined) return;
    try {
      await deps.api.call("deleteMessage", {
        chat_id: dialog.target.chatId,
        message_id: dialog.messageId,
      });
    } catch (error) {
      deps.recordEvent?.(error, {
        phase: "worker-ui-prompt-cleanup",
        workerId: dialog.workerId,
      });
    }
  };

  const isCurrentRoute = (dialog: Dialog): boolean => {
    const route = deps.resolveRoute(dialog.workerId);
    return (
      route !== undefined &&
      route.registrationGeneration === dialog.generation &&
      targetKey(route.target) === targetKey(dialog.target)
    );
  };

  const publish = async (
    dialog: Dialog,
    text: string,
    keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] },
  ): Promise<void> => {
    try {
      const response = await deps.api.call("sendMessage", {
        chat_id: dialog.target.chatId,
        ...(dialog.target.threadId !== undefined
          ? { message_thread_id: dialog.target.threadId }
          : {}),
        text,
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      dialog.messageId = readMessageId(response);
      if (!isCurrentRoute(dialog)) {
        respondOnce(dialog, { cancelled: true });
        await removePrompt(dialog);
      }
    } catch (error) {
      deps.recordEvent?.(error, {
        phase: "worker-ui-publish",
        workerId: dialog.workerId,
      });
      respondOnce(dialog, { cancelled: true });
    }
  };

  const publishNotify = (workerId: string, message: string): void => {
    const route = deps.resolveRoute(workerId);
    if (!route) return;
    void deps.api
      .call("sendMessage", {
        chat_id: route.target.chatId,
        ...(route.target.threadId !== undefined
          ? { message_thread_id: route.target.threadId }
          : {}),
        text: escapeHtml(message.slice(0, MAX_TEXT_LENGTH)),
        parse_mode: "HTML",
      })
      .catch((error) =>
        deps.recordEvent?.(error, { phase: "worker-ui-notify", workerId }),
      );
  };

  const handleRequest = (
    workerId: string,
    request: unknown,
    respond: TelegramManagedWorkerUiResponder,
  ): void => {
    if (
      isRecord(request) &&
      request.type === "extension_ui_request" &&
      request.method === "notify"
    ) {
      if (typeof request.message === "string") {
        publishNotify(workerId, request.message);
      }
      return;
    }
    const dialogRequest = parseTelegramManagedWorkerUiRequest(request);
    if (!dialogRequest) {
      // A dialog method that failed bounded validation must still resolve, or the
      // worker's promise never settles. Fire-and-forget projections need no reply.
      if (
        isRecord(request) &&
        (request.method === "select" ||
          request.method === "confirm" ||
          request.method === "input" ||
          request.method === "editor")
      ) {
        respond({ cancelled: true });
      }
      return;
    }
    if (dialogs.size >= MAX_DIALOGS) {
      respond({ cancelled: true });
      deps.recordEvent?.("Managed worker UI dialog capacity exceeded.", {
        phase: "worker-ui-capacity",
        workerId,
      });
      return;
    }
    const route = deps.resolveRoute(workerId);
    if (!route) {
      respond({ cancelled: true });
      return;
    }
    const dialog: Dialog = {
      id: createId(),
      workerId,
      generation: route.registrationGeneration,
      target: { ...route.target },
      method: dialogRequest.method,
      respond,
      ...(dialogRequest.options ? { options: dialogRequest.options } : {}),
      timer: setTimeout(() => {
        respondOnce(dialog, { cancelled: true });
        void removePrompt(dialog);
      }, timeoutMs),
    };
    dialog.timer.unref?.();
    dialogs.set(dialog.id, dialog);

    if (dialogRequest.method === "select" || dialogRequest.method === "confirm") {
      const options =
        dialogRequest.method === "confirm"
          ? ["Yes", "No"]
          : (dialogRequest.options ?? []);
      const buttons = options.map((label, index) => [
        {
          text: label.slice(0, 64),
          callback_data: `${CALLBACK_PREFIX}${dialog.id}:${index}`,
        },
      ]);
      const detail =
        dialogRequest.method === "confirm" && dialogRequest.message
          ? `\n${escapeHtml(dialogRequest.message)}`
          : "";
      void publish(
        dialog,
        `<b>${escapeHtml(dialogRequest.title)}</b>${detail}`,
        { inline_keyboard: buttons },
      );
      return;
    }
    const hint =
      dialogRequest.method === "input" && dialogRequest.placeholder
        ? `\n<i>${escapeHtml(dialogRequest.placeholder)}</i>`
        : dialogRequest.method === "editor" && dialogRequest.prefill
          ? `\n<pre>${escapeHtml(dialogRequest.prefill)}</pre>`
          : "";
    void publish(
      dialog,
      `<b>${escapeHtml(dialogRequest.title)}</b>${hint}\nReply to this message with your input.`,
    );
  };

  const consumeCallback = async (
    callback: Record<string, unknown>,
    target: TelegramTarget,
    callbackId: string,
  ): Promise<"pass" | "consume"> => {
    const data = typeof callback.data === "string" ? callback.data : "";
    if (!data.startsWith(CALLBACK_PREFIX)) return "pass";
    const fromId =
      isRecord(callback.from) && Number.isSafeInteger(callback.from.id)
        ? (callback.from.id as number)
        : undefined;
    const allowedUserId = deps.getAllowedUserId();
    const match = new RegExp(
      `^${CALLBACK_PREFIX}([A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}):(\\d{1,2})$`,
      "u",
    ).exec(data);
    if (!match || fromId !== allowedUserId) return "consume";
    const dialog = dialogs.get(match[1]!);
    if (
      !dialog ||
      dialog.method === "input" ||
      dialog.method === "editor" ||
      targetKey(dialog.target) !== targetKey(target) ||
      !isCurrentRoute(dialog)
    ) {
      // A dialog whose route/generation moved must resolve, not linger.
      if (dialog) {
        respondOnce(dialog, { cancelled: true });
        await removePrompt(dialog);
      }
      try {
        await deps.api.call("answerCallbackQuery", {
          callback_query_id: callbackId,
          text: "This Pi dialog has expired.",
          show_alert: true,
        });
      } catch {
        /* A stale callback remains consumed regardless of the toast outcome. */
      }
      return "consume";
    }
    const index = Number(match[2]);
    const options =
      dialog.method === "confirm" ? ["Yes", "No"] : (dialog.options ?? []);
    const value = options[index];
    if (typeof value !== "string") return "consume";
    respondOnce(
      dialog,
      dialog.method === "confirm" ? { confirmed: index === 0 } : { value },
    );
    try {
      await deps.api.call("answerCallbackQuery", { callback_query_id: callbackId });
      const messageId = readMessageId(callback.message);
      if (messageId !== undefined) {
        await deps.api.call("editMessageText", {
          chat_id: target.chatId,
          message_id: messageId,
          text: "✅ <b>Response sent to Pi.</b>",
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      }
    } catch (error) {
      deps.recordEvent?.(error, {
        phase: "worker-ui-callback",
        workerId: dialog.workerId,
      });
    }
    return "consume";
  };

  const consumeText = async (
    message: Record<string, unknown>,
    target: TelegramTarget,
  ): Promise<"pass" | "consume"> => {
    const allowedUserId = deps.getAllowedUserId();
    if (
      typeof message.text !== "string" ||
      !Number.isSafeInteger(allowedUserId) ||
      !isRecord(message.from) ||
      message.from.id !== allowedUserId
    ) {
      return "pass";
    }
    const dialog = [...dialogs.values()].find(
      (entry) =>
        (entry.method === "input" || entry.method === "editor") &&
        targetKey(entry.target) === targetKey(target),
    );
    if (!dialog) return "pass";
    if (!isCurrentRoute(dialog)) {
      respondOnce(dialog, { cancelled: true });
      await removePrompt(dialog);
      return "consume";
    }
    respondOnce(dialog, { value: message.text.slice(0, MAX_TEXT_LENGTH) });
    await removePrompt(dialog);
    return "consume";
  };

  const handleUpdate = async (update: unknown): Promise<"pass" | "consume"> => {
    if (!isRecord(update)) return "pass";
    const callback = isRecord(update.callback_query)
      ? update.callback_query
      : undefined;
    if (callback) {
      const target = readTarget(callback.message);
      if (
        target &&
        typeof callback.id === "string" &&
        typeof callback.data === "string" &&
        callback.data.startsWith(CALLBACK_PREFIX)
      ) {
        return consumeCallback(callback, target, callback.id);
      }
      return "pass";
    }
    const message = isRecord(update.message) ? update.message : undefined;
    if (!message) return "pass";
    const target = readTarget(message);
    if (!target) return "pass";
    return consumeText(message, target);
  };

  return {
    handleRequest,
    handleUpdate,
    start: () => getTelegramUpdateHandlerRegistry().add(handleUpdate),
    cancelWorker(workerId) {
      for (const dialog of [...dialogs.values()]) {
        if (dialog.workerId !== workerId) continue;
        respondOnce(dialog, { cancelled: true });
        void removePrompt(dialog);
      }
    },
    dispose() {
      for (const dialog of [...dialogs.values()]) {
        respondOnce(dialog, { cancelled: true });
        void removePrompt(dialog);
      }
    },
    pendingCount: () => dialogs.size,
  };
}

export const TELEGRAM_MANAGED_WORKER_UI_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const TELEGRAM_MANAGED_WORKER_UI_DIALOG_CAPACITY = MAX_DIALOGS;
export const TELEGRAM_MANAGED_WORKER_UI_OPTION_CAPACITY = MAX_OPTIONS;
export const TELEGRAM_MANAGED_WORKER_UI_TEXT_LIMIT = MAX_TEXT_LENGTH;
export const TELEGRAM_MANAGED_WORKER_UI_CALLBACK_PREFIX = CALLBACK_PREFIX;
