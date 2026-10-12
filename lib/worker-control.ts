/**
 * Daemon worker control surface
 * Zones: daemon control plane, telegram controls
 * Owns the operator-facing worker control plane: `/workers` listing, thread
 * attachment, and start/stop/restart/logs dispatch. It renders Telegram HTML and
 * delegates every process action to an injected control port, so the surface is
 * testable without a live Telegram connection or a spawned Pi process.
 */

import { TELEGRAM_WORKER_CALLBACK_PREFIX } from "./worker-browser.ts";
import { TELEGRAM_DEFAULT_LOCALE, t, type TelegramLocale } from "./i18n.ts";
import type { TelegramTarget } from "./target.ts";
import type {
  TelegramWorkerView,
  TelegramWorkerRegistry,
} from "./worker-registry.ts";
import type { TelegramRouteRegistry } from "./route-registry.ts";

export type TelegramWorkerCommand =
  | { kind: "menu" }
  | { kind: "status" }
  /** Proof-only inactive Thread review layer. */
  | { kind: "cleanup" }
  | { kind: "cleanupReview" }
  | { kind: "cleanupToggle" }
  | { kind: "cleanupUnattendedToggle" }
  /** Destructive completion of one reviewed work set. */
  | { kind: "cleanupDelete" }
  | { kind: "list" }
  /** Ask before terminating a managed worker; the confirm layer is its own step. */
  | { kind: "stopAsk"; workerId: string }
  | { kind: "browse"; path?: string }
  | { kind: "attach"; workerId: string }
  | { kind: "detach" }
  | { kind: "start"; spec: string }
  | { kind: "stop"; workerId: string }
  | { kind: "restart"; workerId: string }
  | { kind: "logs"; workerId: string };

export interface TelegramWorkerControlPort {
  start: (specName: string) => Promise<{ ok: boolean; message: string }>;
  stop: (workerId: string) => Promise<{ ok: boolean; message: string }>;
  restart: (workerId: string) => Promise<{ ok: boolean; message: string }>;
  logs?: (workerId: string) => Promise<{ ok: boolean; message: string }>;
  /**
   * Re-home a live worker's Telegram Thread to `target` so inbound delivery actually
   * follows the attachment. Absent means this topology cannot attach threads.
   */
  attach?: (input: {
    workerId: string;
    target: TelegramTarget;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Undo the most recent attach recorded for `target`. */
  detach?: (input: {
    target: TelegramTarget;
  }) => Promise<{ ok: boolean; message: string }>;
}

export interface TelegramWorkerCommandContext {
  target: TelegramTarget;
  epoch: string;
  nowMs?: number;
}

export interface TelegramWorkerInlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface TelegramWorkerControlResult {
  ok: boolean;
  html: string;
  keyboard?: TelegramWorkerInlineKeyboard;
  /** Toast text for the acting callback; the layer itself stays put. */
  alert?: string;
}

export interface TelegramWorkerControl {
  parse: (args: string) => TelegramWorkerCommand;
  renderList: () => string;
  execute: (
    command: TelegramWorkerCommand,
    context: TelegramWorkerCommandContext,
  ) => Promise<TelegramWorkerControlResult>;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

const NOTICE_NO_WORKERS = "📭 **No live Pi workers.**";

/** Callback verbs shared by the daemon menu and the directory picker. */
export const TELEGRAM_WORKER_MENU_CALLBACKS = {
  menu: `${TELEGRAM_WORKER_CALLBACK_PREFIX}m`,
  workers: `${TELEGRAM_WORKER_CALLBACK_PREFIX}w`,
  status: `${TELEGRAM_WORKER_CALLBACK_PREFIX}t`,
  /** Opens the directory picker. */
  newWorker: `${TELEGRAM_WORKER_CALLBACK_PREFIX}b`,
  /** Returns a nested layer to the roster without closing the panel. */
  backToRoster: `${TELEGRAM_WORKER_CALLBACK_PREFIX}c`,
  /** Explicit operator dismissal; the only action that closes the panel. */
  close: `${TELEGRAM_WORKER_CALLBACK_PREFIX}x`,
  /** Prefix for a per-worker locator button: `ptw:l:<workerId>`. */
  locate: `${TELEGRAM_WORKER_CALLBACK_PREFIX}l:`,
  /** Prefix for the stop confirmation layer: `ptw:z:<workerId>`. */
  stopAsk: `${TELEGRAM_WORKER_CALLBACK_PREFIX}z:`,
  /** Prefix for the confirmed stop: `ptw:y:<workerId>`. */
  stop: `${TELEGRAM_WORKER_CALLBACK_PREFIX}y:`,
  /** Prefix for an immediate restart: `ptw:r:<workerId>`. */
  restart: `${TELEGRAM_WORKER_CALLBACK_PREFIX}r:`,
  /** Inactive-Thread cleanup layer, its proof-only review, and its switches. */
  cleanup: `${TELEGRAM_WORKER_CALLBACK_PREFIX}k`,
  cleanupReview: `${TELEGRAM_WORKER_CALLBACK_PREFIX}j`,
  cleanupToggle: `${TELEGRAM_WORKER_CALLBACK_PREFIX}e`,
  cleanupUnattendedToggle: `${TELEGRAM_WORKER_CALLBACK_PREFIX}n`,
  /** Delete the reviewed inactive tabs. */
  cleanupDelete: `${TELEGRAM_WORKER_CALLBACK_PREFIX}d`,
} as const;

/** Short roster label: the project directory, falling back to the worker id. */
export function resolveTelegramWorkerLabel(worker: {
  cwd: string;
  workerId: string;
}): string {
  return worker.cwd.split("/").filter(Boolean).pop() ?? worker.workerId;
}

export function parseTelegramWorkerCommand(args: string): TelegramWorkerCommand {
  const [verb, ...rest] = args.trim().split(/\s+/u).filter(Boolean);
  const argument = rest[0] ?? "";
  switch ((verb ?? "").toLowerCase()) {
    case "start":
    case "new":
    case "spawn":
      return argument ? { kind: "start", spec: argument } : { kind: "list" };
    case "stop":
      return argument ? { kind: "stop", workerId: argument } : { kind: "list" };
    case "restart":
      return argument ? { kind: "restart", workerId: argument } : { kind: "list" };
    case "logs":
      return argument ? { kind: "logs", workerId: argument } : { kind: "list" };
    case "attach":
      return argument ? { kind: "attach", workerId: argument } : { kind: "list" };
    case "browse":
      return argument ? { kind: "browse", path: argument } : { kind: "browse" };
    case "detach":
      return { kind: "detach" };
    case "menu":
    case "daemon":
      return { kind: "menu" };
    default:
      return { kind: "list" };
  }
}

function formatWorkerState(worker: TelegramWorkerView): string {
  return worker.state === "ready" ? "🟢" : worker.state === "draining" ? "🟡" : "⚪";
}

export function renderTelegramWorkerList(
  workers: readonly TelegramWorkerView[],
  routes: readonly { target: TelegramTarget; workerId: string }[],
  options: { leaderWorkerId?: string } = {},
): string {
  if (workers.length === 0) return NOTICE_NO_WORKERS;
  const routesByWorker = new Map<string, TelegramTarget[]>();
  for (const route of routes) {
    const existing = routesByWorker.get(route.workerId);
    if (existing) existing.push(route.target);
    else routesByWorker.set(route.workerId, [route.target]);
  }
  const describeTargets = (targets: readonly TelegramTarget[]): string =>
    targets
      .map((target) =>
        target.threadId !== undefined
          ? `thread ${target.threadId}`
          : `chat ${target.chatId}`,
      )
      .join(", ");
  const lines = workers
    .slice()
    .sort((left, right) => left.connectedAtMs - right.connectedAtMs)
    .map((worker) => {
      const targets = routesByWorker.get(worker.workerId) ?? [];
      const target =
        worker.workerId === options.leaderWorkerId
          ? "leader"
          : targets.length > 0
            ? describeTargets(targets)
            : "no route";
      return `${formatWorkerState(worker)} <code>${escapeTelegramHtml(worker.workerId)}</code> · ${escapeTelegramHtml(worker.kind)} · ${escapeTelegramHtml(worker.cwd)} · session ${escapeTelegramHtml(worker.sessionId || "—")} · ${target}`;
    });
  return `👷 <b>Live Pi workers</b>\n${lines.join("\n")}`;
}

export interface TelegramWorkerControlDeps {
  workers: TelegramWorkerRegistry;
  routes: TelegramRouteRegistry;
  control?: TelegramWorkerControlPort;
  /** Directory picker; daemon-only. */
  browse?: (path?: string) => TelegramWorkerControlResult;
  /** Daemon status view rendered by the menu's Status action. */
  renderStatus?: () => string;
  /**
   * Leader-side inactive-Thread cleanup. `review` is proof-only and never deletes a
   * tab; deletion stays a separate, explicitly authorized step.
   */
  cleanup?: {
    review: (options?: {
      inactiveBeforeMs?: number;
    }) => Promise<{ count: number; operationId?: string }>;
    /**
     * Delete every currently eligible inactive Thread. Eligibility is re-proven by the
     * planner immediately before each deletion. Omitted by a non-destructive composition.
     */
    deleteEligible?: () => Promise<{ deleted: number; blocked: number }>;
    isAutomaticCleanupEnabled: () => boolean;
    setAutomaticCleanup: (enabled: boolean) => Promise<void>;
    /** Unattended janitor switch; omitted by a composition that may not delete unattended. */
    isUnattendedCleanupEnabled?: () => boolean;
    setUnattendedCleanup?: (enabled: boolean) => Promise<void>;
  };
  /** Resolved UI locale for this profile. Defaults to English when absent. */
  getLocale?: () => TelegramLocale;

}

export function createTelegramWorkerControl(
  deps: TelegramWorkerControlDeps,
): TelegramWorkerControl {
  const locale = (): TelegramLocale =>
    deps.getLocale?.() ?? TELEGRAM_DEFAULT_LOCALE;
  const renderList = () =>
    renderTelegramWorkerList(deps.workers.list(), deps.routes.list());

  const backToMenu = (): TelegramWorkerInlineKeyboard => ({
    inline_keyboard: [
      [{ text: t(locale(), "daemon.menu"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu }],
    ],
  });

  const rosterKeyboard = (): TelegramWorkerInlineKeyboard => {
    const inline_keyboard: TelegramWorkerInlineKeyboard["inline_keyboard"] = [];
    for (const worker of deps.workers
      .list()
      .slice()
      .sort((left, right) => left.connectedAtMs - right.connectedAtMs)) {
      const label = escapeTelegramHtml(resolveTelegramWorkerLabel(worker));
      inline_keyboard.push([
        {
          text: `📍 ${label}`,
          callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.locate}${worker.workerId}`,
        },
      ]);
      inline_keyboard.push([
        {
          text: t(locale(), "daemon.stop"),
          callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.stopAsk}${worker.workerId}`,
        },
        {
          text: t(locale(), "daemon.restart"),
          callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.restart}${worker.workerId}`,
        },
      ]);
    }
    inline_keyboard.push([
      { text: t(locale(), "daemon.newWorker"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.newWorker },
      { text: t(locale(), "daemon.menu"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu },
    ]);
    return { inline_keyboard };
  };

  const rosterLayer = (): TelegramWorkerControlResult => ({
    ok: true,
    html: renderList(),
    keyboard: rosterKeyboard(),
  });

  const cleanupEnabled = (): boolean =>
    deps.cleanup?.isAutomaticCleanupEnabled() ?? false;
  const unattendedEnabled = (): boolean =>
    deps.cleanup?.isUnattendedCleanupEnabled?.() ?? false;
  const supportsUnattended = (): boolean =>
    !!deps.cleanup?.isUnattendedCleanupEnabled && !!deps.cleanup?.setUnattendedCleanup;

  const cleanupHtml = (note?: string): string =>
    [
      `<b>${t(locale(), "daemon.cleanup.title")}:</b>`,
      `<i>${t(locale(), "daemon.cleanup.line1", {
        state: cleanupEnabled() ? t(locale(), "common.on") : t(locale(), "common.off"),
      })}</i>`,
      `<i>${t(locale(), "daemon.cleanup.line2", {
        state: unattendedEnabled() ? t(locale(), "common.on") : t(locale(), "common.off"),
      })}</i>`,
      `<i>${t(locale(), "daemon.cleanup.line3")}</i>`,
      ...(note ? [`<i>${escapeTelegramHtml(note)}</i>`] : []),
    ].join("\n");

  const cleanupKeyboard = (
    pendingOperationId?: string,
  ): TelegramWorkerInlineKeyboard => ({
    inline_keyboard: [
      [
        {
          text: t(locale(), "daemon.cleanup.reviewInactive"),
          callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupReview,
        },
      ],
      ...(pendingOperationId && deps.cleanup?.deleteEligible
        ? [[
            {
              text: t(locale(), "daemon.cleanup.deleteReviewed"),
              callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupDelete,
            },
          ]]
        : []),
      [
        {
          text: `${cleanupEnabled() ? "🟢" : "⚫"} ${t(locale(), "daemon.cleanup.deleteOnQuit")}`,
          callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupToggle,
        },
      ],
      ...(supportsUnattended()
        ? [[
            {
              text: `${unattendedEnabled() ? "🟢" : "⚫"} ${t(locale(), "daemon.cleanup.unattended")}`,
              callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupUnattendedToggle,
            },
          ]]
        : []),
      [{ text: t(locale(), "daemon.menu"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu }],
    ],
  });

  const cleanupLayer = (
    note?: string,
    pendingOperationId?: string,
  ): TelegramWorkerControlResult => ({
    ok: true,
    html: cleanupHtml(note),
    keyboard: cleanupKeyboard(pendingOperationId),
  });

  const menuKeyboard = (): TelegramWorkerInlineKeyboard => {
    const rows: TelegramWorkerInlineKeyboard["inline_keyboard"] = [
      [
        { text: t(locale(), "daemon.workers"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.workers },
        { text: t(locale(), "daemon.newWorker"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.newWorker },
      ],
    ];
    if (deps.renderStatus || deps.cleanup) {
      rows.push([
        ...(deps.renderStatus
          ? [{ text: t(locale(), "daemon.status"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.status }]
          : []),
        ...(deps.cleanup
          ? [{ text: t(locale(), "daemon.threads"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanup }]
          : []),
      ]);
    }
    rows.push([
      { text: t(locale(), "daemon.close"), callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.close },
    ]);
    return { inline_keyboard: rows };
  };

  const execute = async (
    command: TelegramWorkerCommand,
    context: TelegramWorkerCommandContext,
  ): Promise<TelegramWorkerControlResult> => {
    switch (command.kind) {
      case "menu":
        return {
          ok: true,
          html: `<b>${t(locale(), "daemon.title")}</b>\n<i>${t(locale(), "daemon.subtitle")}</i>`,
          keyboard: menuKeyboard(),
        };
      case "status":
        if (!deps.renderStatus) return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        return { ok: true, html: deps.renderStatus(), keyboard: backToMenu() };
      case "cleanup":
        if (!deps.cleanup) return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        return cleanupLayer();
      case "cleanupReview": {
        if (!deps.cleanup) return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        try {
          const review = await deps.cleanup.review();
          if (review.count === 0) {
            return { ...cleanupLayer(), alert: t(locale(), "daemon.notice.noInactive") };
          }
          return {
            ...cleanupLayer(
              t(locale(), "daemon.notice.reviewPrepared", { count: review.count }),
              review.operationId,
            ),
            alert: t(locale(), "daemon.notice.reviewAlert", { count: review.count }),
          };
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: t(locale(), "daemon.notice.reviewFailed"),
          };
        }
      }
      case "cleanupUnattendedToggle": {
        if (!deps.cleanup?.setUnattendedCleanup) {
          return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        }
        const next = !unattendedEnabled();
        try {
          await deps.cleanup.setUnattendedCleanup(next);
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: t(locale(), "daemon.notice.unattendedFailed"),
          };
        }
        return {
          ...cleanupLayer(),
          alert: next
            ? t(locale(), "daemon.notice.unattendedOn")
            : t(locale(), "daemon.notice.unattendedOff"),
        };
      }
      case "cleanupDelete": {
        if (!deps.cleanup?.deleteEligible) {
          return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        }
        try {
          const result = await deps.cleanup.deleteEligible();
          return {
            ...cleanupLayer(
              t(locale(), "daemon.notice.deleted", { deleted: result.deleted, blocked: result.blocked }),
            ),
            ok: result.blocked === 0,
            alert: t(locale(), "daemon.notice.deletedAlert", { deleted: result.deleted, blocked: result.blocked }),
          };
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: t(locale(), "daemon.notice.deleteFailed"),
          };
        }
      }
      case "cleanupToggle": {
        if (!deps.cleanup) return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        const next = !cleanupEnabled();
        try {
          await deps.cleanup.setAutomaticCleanup(next);
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: t(locale(), "daemon.notice.cleanupFailed"),
          };
        }
        return {
          ...cleanupLayer(),
          alert: next ? t(locale(), "daemon.notice.cleanupOn") : t(locale(), "daemon.notice.cleanupOff"),
        };
      }
      case "list":
        return rosterLayer();
      case "browse":
        if (!deps.browse) return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        return deps.browse(command.path);
      case "attach": {
        const worker = deps.workers.get(command.workerId);
        if (!worker) return { ok: false, html: t(locale(), "daemon.unknownWorker") };
        if (!deps.control?.attach) {
          return {
            ok: false,
            html: t(locale(), "daemon.notice.attachUnavailable"),
          };
        }
        const result = await deps.control.attach({
          workerId: worker.workerId,
          target: context.target,
        });
        if (!result.ok) {
          return {
            ok: false,
            html: `${t(locale(), "daemon.notice.attachFailed")}\n<i>${escapeTelegramHtml(result.message)}</i>`,
          };
        }
        return {
          ok: true,
          html: t(locale(), "daemon.notice.attached", { worker: escapeTelegramHtml(worker.workerId) }),
        };
      }
      case "detach": {
        if (!deps.control?.detach) {
          return { ok: true, html: t(locale(), "daemon.notice.noWorker") };
        }
        const result = await deps.control.detach({ target: context.target });
        return result.ok
          ? { ok: true, html: t(locale(), "daemon.notice.detached") }
          : { ok: true, html: `ℹ️ **${escapeTelegramHtml(result.message)}**` };
      }
      case "stopAsk": {
        const worker = deps.workers.get(command.workerId);
        if (!worker) return { ok: false, html: t(locale(), "daemon.unknownWorker") };
        const label = escapeTelegramHtml(resolveTelegramWorkerLabel(worker));
        return {
          ok: true,
          html: `<b>${t(locale(), "daemon.stop.confirmTitle", { label })}</b>\n<i>${t(locale(), "daemon.stop.confirmBody")}</i>`,
          keyboard: {
            inline_keyboard: [
              [
                {
                  text: t(locale(), "daemon.stop"),
                  callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.stop}${worker.workerId}`,
                },
              ],
              [
                {
                  text: t(locale(), "daemon.back"),
                  callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.backToRoster,
                },
              ],
            ],
          },
        };
      }
      case "start":
      case "stop":
      case "restart":
      case "logs": {
        if (!deps.control) {
          return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        }
        // A stale button for a worker that already left reports that plainly instead
        // of asking the supervisor to act on an unknown target.
        if (command.kind !== "start" && !deps.workers.get(command.workerId)) {
          return { ok: false, html: t(locale(), "daemon.unknownWorker") };
        }
        if (command.kind === "start") {
          const result = await deps.control.start(command.spec);
          return { ok: result.ok, html: escapeTelegramHtml(result.message) };
        }
        if (command.kind === "stop") {
          const result = await deps.control.stop(command.workerId);
          // A lifecycle action keeps the operator on the roster, which re-renders
          // the worker's new state; it never closes the panel.
          return { ...rosterLayer(), ok: result.ok, alert: result.message };
        }
        if (command.kind === "restart") {
          const result = await deps.control.restart(command.workerId);
          return { ...rosterLayer(), ok: result.ok, alert: result.message };
        }
        if (!deps.control.logs) {
          return { ok: false, html: t(locale(), "daemon.managedUnavailable") };
        }
        const result = await deps.control.logs(command.workerId);
        return { ok: result.ok, html: escapeTelegramHtml(result.message) };
      }
    }
  };

  return {
    parse: parseTelegramWorkerCommand,
    renderList,
    execute,
  };
}
