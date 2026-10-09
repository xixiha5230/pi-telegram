/**
 * Telegram daemon control menu routing
 * Zones: daemon control plane, telegram controls
 * Registers the single `/daemon` command on the public pre-routing update-handler
 * registry. Everything else the operator does is a button inside that menu, so the
 * daemon thread stays a menu surface instead of a command surface. A matched
 * command always consumes its update, even when every reply attempt fails:
 * falling through would silently turn the command into a model prompt.
 */

import { getTelegramUpdateHandlerRegistry } from "./updates.ts";
import type { TelegramTarget } from "./target.ts";
import {
  TELEGRAM_WORKER_MENU_CALLBACKS,
  type TelegramWorkerCommand,
  type TelegramWorkerControl,
  type TelegramWorkerControlResult,
  type TelegramWorkerInlineKeyboard,
} from "./worker-control.ts";
import { TELEGRAM_WORKER_CALLBACK_PREFIX } from "./worker-browser.ts";

/** Minimal leader transport port; the bridge's bus-aware API runtime satisfies it. */
export interface TelegramWorkerCommandApiPort {
  call: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface TelegramWorkerCommandDeps {
  control: TelegramWorkerControl;
  epoch: string;
  api: TelegramWorkerCommandApiPort;
  /** Returns false to pass the update through, e.g. when not the transport leader. */
  enabled?: () => boolean;
  /**
   * Restricts the daemon-only menu to targets the transport leader itself
   * serves. Follower-owned threads return `pass` and route to the worker.
   */
  isDaemonOwnedTarget?: (target: TelegramTarget) => boolean;
  /** Directory-picker callbacks; daemon-only. */
  workerCallback?: (
    data: string,
  ) => TelegramWorkerControlResult & { alert?: string };
  /** Per-worker locator button: posts a marker into that worker's own thread. */
  locateWorker?: (
    workerId: string,
  ) => Promise<{ ok: boolean; alert?: string; html?: string }>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

/** The daemon thread handles the panel, the roster, and operator Thread attachment. */
const DAEMON_COMMAND_NAMES = new Set(["daemon", "workers", "attach", "detach"]);

function readCallbackQuery(
  update: unknown,
): { id: string; data: string; target: TelegramTarget; messageId: number } | undefined {
  if (!update || typeof update !== "object") return undefined;
  const query = (update as { callback_query?: unknown }).callback_query;
  if (!query || typeof query !== "object") return undefined;
  const record = query as {
    id?: unknown;
    data?: unknown;
    message?: {
      chat?: { id?: unknown };
      message_id?: unknown;
      message_thread_id?: unknown;
    };
  };
  const chatId = record.message?.chat?.id;
  const messageId = record.message?.message_id;
  if (typeof record.id !== "string" || typeof record.data !== "string") {
    return undefined;
  }
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) {
    return undefined;
  }
  const threadId = record.message?.message_thread_id;
  return {
    id: record.id,
    data: record.data,
    messageId: messageId as number,
    target: {
      chatId: chatId as number,
      ...(Number.isSafeInteger(threadId) ? { threadId: threadId as number } : {}),
    },
  };
}

function readCommandTarget(
  update: unknown,
): { target: TelegramTarget; text: string } | undefined {
  if (!update || typeof update !== "object") return undefined;
  const message = (update as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const record = message as {
    chat?: { id?: unknown };
    message_thread_id?: unknown;
    text?: unknown;
  };
  const chatId = record.chat?.id;
  const text = record.text;
  if (!Number.isSafeInteger(chatId) || typeof text !== "string") return undefined;
  const threadId = record.message_thread_id;
  return {
    text,
    target: {
      chatId: chatId as number,
      ...(Number.isSafeInteger(threadId) ? { threadId: threadId as number } : {}),
    },
  };
}

function stripTelegramHtml(html: string): string {
  return html
    .replace(/<[^>]*>/gu, "")
    .replace(/\*\*/gu, "")
    .trim();
}

/**
 * Register the transport-owner daemon menu. Returns a disposer.
 */
export function registerTelegramWorkerCommands(
  deps: TelegramWorkerCommandDeps,
): () => void {
  const registry = getTelegramUpdateHandlerRegistry();

  const reply = async (
    target: TelegramTarget,
    html: string,
    command: string,
    keyboard?: TelegramWorkerInlineKeyboard,
  ): Promise<boolean> => {
    const threadParams =
      target.threadId !== undefined
        ? { message_thread_id: target.threadId }
        : {};
    const attempts: Array<Record<string, unknown>> = [
      {
        chat_id: target.chatId,
        ...threadParams,
        text: html,
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      },
      {
        chat_id: target.chatId,
        ...threadParams,
        text: stripTelegramHtml(html),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      },
      { chat_id: target.chatId, text: stripTelegramHtml(html) },
    ];
    for (const params of attempts) {
      try {
        await deps.api.call("sendMessage", params);
        return true;
      } catch (error) {
        deps.recordRuntimeEvent?.("telegram-command", error, {
          command,
          phase: "worker-command-reply",
        });
      }
    }
    return false;
  };

  const resolveCallback = async (
    data: string,
    target: TelegramTarget,
  ): Promise<TelegramWorkerControlResult> => {
    const context = { target, epoch: deps.epoch };
    // The panel closes only when the operator asks it to.
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.close) {
      return { ok: true, html: "✖️ **Control panel closed.**" };
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.menu) {
      return deps.control.execute({ kind: "menu" }, context);
    }
    if (
      data === TELEGRAM_WORKER_MENU_CALLBACKS.workers ||
      data === TELEGRAM_WORKER_MENU_CALLBACKS.backToRoster
    ) {
      return deps.control.execute({ kind: "list" }, context);
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.status) {
      return deps.control.execute({ kind: "status" }, context);
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.cleanup) {
      return deps.control.execute({ kind: "cleanup" }, context);
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.cleanupReview) {
      return deps.control.execute({ kind: "cleanupReview" }, context);
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.cleanupToggle) {
      return deps.control.execute({ kind: "cleanupToggle" }, context);
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.cleanupUnattendedToggle) {
      return deps.control.execute({ kind: "cleanupUnattendedToggle" }, context);
    }
    if (data === TELEGRAM_WORKER_MENU_CALLBACKS.cleanupDelete) {
      return deps.control.execute({ kind: "cleanupDelete" }, context);
    }
    for (const [prefix, kind] of [
      [TELEGRAM_WORKER_MENU_CALLBACKS.stopAsk, "stopAsk"],
      [TELEGRAM_WORKER_MENU_CALLBACKS.stop, "stop"],
      [TELEGRAM_WORKER_MENU_CALLBACKS.restart, "restart"],
    ] as const) {
      if (!data.startsWith(prefix)) continue;
      const workerId = data.slice(prefix.length);
      if (!workerId) return { ok: false, html: "⚠️ **Unknown Pi worker.**" };
      return deps.control.execute({ kind, workerId }, context);
    }
    if (
      data.startsWith(TELEGRAM_WORKER_MENU_CALLBACKS.locate) &&
      deps.locateWorker
    ) {
      const workerId = data.slice(TELEGRAM_WORKER_MENU_CALLBACKS.locate.length);
      if (!workerId) return { ok: false, html: "⚠️ **Unknown Pi worker.**" };
      const located = await deps.locateWorker(workerId);
      return {
        ok: located.ok,
        html: located.html ?? "",
        ...(located.alert ? { alert: located.alert } : {}),
      };
    }
    if (!deps.workerCallback) return { ok: false, html: "⚠️ **Unknown action.**" };
    return deps.workerCallback(data);
  };

  return registry.add(async (update) => {
    if (deps.enabled && !deps.enabled()) return "pass";
    const callback = readCallbackQuery(update);
    if (callback) {
      if (!callback.data.startsWith(TELEGRAM_WORKER_CALLBACK_PREFIX)) return "pass";
      const outcome = await resolveCallback(callback.data, callback.target);
      try {
        await deps.api.call("answerCallbackQuery", {
          callback_query_id: callback.id,
          ...(outcome.alert
            ? { text: outcome.alert, ...(outcome.ok ? {} : { show_alert: true }) }
            : {}),
        });
        if (outcome.html) {
          await deps.api.call("editMessageText", {
            chat_id: callback.target.chatId,
            message_id: callback.messageId,
            text: outcome.html,
            parse_mode: "HTML",
            ...(outcome.keyboard ? { reply_markup: outcome.keyboard } : {}),
          });
        }
      } catch (error) {
        deps.recordRuntimeEvent?.("telegram-command", error, {
          phase: "worker-callback",
        });
      }
      return "consume";
    }
    const source = readCommandTarget(update);
    if (!source) return "pass";
    const trimmed = source.text.trim();
    if (!trimmed.startsWith("/")) return "pass";
    const [rawName = "", ...rest] = trimmed.slice(1).split(/\s+/u);
    const name = rawName.split("@")[0]?.toLowerCase() ?? "";
    if (!DAEMON_COMMAND_NAMES.has(name)) return "pass";
    if (deps.isDaemonOwnedTarget && !deps.isDaemonOwnedTarget(source.target)) {
      // Follower-owned thread: let the update route to its worker.
      return "pass";
    }
    const command: TelegramWorkerCommand =
      name === "workers"
        ? deps.control.parse(rest.join(" "))
        : name === "attach"
          ? { kind: "attach", workerId: (rest[0] ?? "").trim() }
          : name === "detach"
            ? { kind: "detach" }
            : { kind: "menu" };
    let html = "⚠️ **The daemon control menu failed.**";
    let ok = false;
    let keyboard: TelegramWorkerInlineKeyboard | undefined;
    try {
      const result = await deps.control.execute(command, {
        target: source.target,
        epoch: deps.epoch,
      });
      html = result.html;
      ok = result.ok;
      keyboard = result.keyboard;
    } catch (error) {
      deps.recordRuntimeEvent?.("telegram-command", error, {
        command: name,
        phase: "worker-command",
      });
    }
    const delivered = await reply(source.target, html, name, keyboard);
    deps.recordRuntimeEvent?.(
      "telegram-command",
      "Telegram daemon menu handled",
      { command: name, phase: "worker-command", ok, delivered },
    );
    return "consume";
  });
}
