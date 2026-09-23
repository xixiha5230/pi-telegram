/**
 * Daemon worker control surface
 * Zones: daemon control plane, telegram controls
 * Owns the operator-facing worker control plane: `/workers` listing, thread
 * attachment, and start/stop/restart/logs dispatch. It renders Telegram HTML and
 * delegates every process action to an injected control port, so the surface is
 * testable without a live Telegram connection or a spawned Pi process.
 */

import { TELEGRAM_WORKER_CALLBACK_PREFIX } from "./worker-browser.ts";
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
const NOTICE_UNKNOWN_WORKER = "⚠️ **Unknown Pi worker.**";
const NOTICE_MANAGED_UNAVAILABLE =
  "🚫 **Managed Pi workers are unavailable.**";
const MENU_HTML = "🛠️ <b>Daemon control:</b>\n<i>Pick an action below.</i>";

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

}

export function createTelegramWorkerControl(
  deps: TelegramWorkerControlDeps,
): TelegramWorkerControl {
  const renderList = () =>
    renderTelegramWorkerList(deps.workers.list(), deps.routes.list());

  const backToMenu = (): TelegramWorkerInlineKeyboard => ({
    inline_keyboard: [
      [{ text: "↩️ Menu", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu }],
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
          text: "🛑 Stop",
          callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.stopAsk}${worker.workerId}`,
        },
        {
          text: "♻️ Restart",
          callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.restart}${worker.workerId}`,
        },
      ]);
    }
    inline_keyboard.push([
      { text: "📁 New worker…", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.newWorker },
      { text: "↩️ Menu", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu },
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
      "🧹 <b>Inactive Threads:</b>",
      `<i>Deleting this instance's tab on graceful quit is ${cleanupEnabled() ? "on" : "off"}.</i>`,
      `<i>Deleting proven inactive tabs unattended is ${unattendedEnabled() ? "on" : "off"}; only tabs idle for over 24h qualify.</i>`,
      "<i>Review only proves which tabs are inactive; deleting needs an explicit tap or the unattended switch.</i>",
      ...(note ? [`<i>${escapeTelegramHtml(note)}</i>`] : []),
    ].join("\n");

  const cleanupKeyboard = (
    pendingOperationId?: string,
  ): TelegramWorkerInlineKeyboard => ({
    inline_keyboard: [
      [
        {
          text: "🔍 Review inactive",
          callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupReview,
        },
      ],
      ...(pendingOperationId && deps.cleanup?.deleteEligible
        ? [[
            {
              text: "🗑 Delete reviewed",
              callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupDelete,
            },
          ]]
        : []),
      [
        {
          text: cleanupEnabled()
            ? "🟢 Delete tab on quit"
            : "⚫ Delete tab on quit",
          callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupToggle,
        },
      ],
      ...(supportsUnattended()
        ? [[
            {
              text: unattendedEnabled()
                ? "🟢 Unattended cleanup"
                : "⚫ Unattended cleanup",
              callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanupUnattendedToggle,
            },
          ]]
        : []),
      [{ text: "↩️ Menu", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.menu }],
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
        { text: "👷 Workers", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.workers },
        { text: "📁 New worker…", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.newWorker },
      ],
    ];
    if (deps.renderStatus || deps.cleanup) {
      rows.push([
        ...(deps.renderStatus
          ? [{ text: "ℹ️ Status", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.status }]
          : []),
        ...(deps.cleanup
          ? [{ text: "🧹 Threads", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.cleanup }]
          : []),
      ]);
    }
    rows.push([
      { text: "✖️ Close", callback_data: TELEGRAM_WORKER_MENU_CALLBACKS.close },
    ]);
    return { inline_keyboard: rows };
  };

  const execute = async (
    command: TelegramWorkerCommand,
    context: TelegramWorkerCommandContext,
  ): Promise<TelegramWorkerControlResult> => {
    switch (command.kind) {
      case "menu":
        return { ok: true, html: MENU_HTML, keyboard: menuKeyboard() };
      case "status":
        if (!deps.renderStatus) return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        return { ok: true, html: deps.renderStatus(), keyboard: backToMenu() };
      case "cleanup":
        if (!deps.cleanup) return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        return cleanupLayer();
      case "cleanupReview": {
        if (!deps.cleanup) return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        try {
          const review = await deps.cleanup.review();
          if (review.count === 0) {
            return { ...cleanupLayer(), alert: "No proven inactive tabs." };
          }
          return {
            ...cleanupLayer(
              `Review prepared ${review.count} proven inactive tab(s). Nothing was deleted.`,
              review.operationId,
            ),
            alert: `${review.count} proven inactive tab(s); nothing was deleted.`,
          };
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: "Could not safely review inactive tabs.",
          };
        }
      }
      case "cleanupUnattendedToggle": {
        if (!deps.cleanup?.setUnattendedCleanup) {
          return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        }
        const next = !unattendedEnabled();
        try {
          await deps.cleanup.setUnattendedCleanup(next);
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: "Could not change the unattended cleanup setting.",
          };
        }
        return {
          ...cleanupLayer(),
          alert: next
            ? "Provably inactive tabs now delete unattended."
            : "Unattended deletion is off.",
        };
      }
      case "cleanupDelete": {
        if (!deps.cleanup?.deleteEligible) {
          return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        }
        try {
          const result = await deps.cleanup.deleteEligible();
          return {
            ...cleanupLayer(
              `Deleted ${result.deleted} tab(s); ${result.blocked} stayed blocked.`,
            ),
            ok: result.blocked === 0,
            alert: `Deleted ${result.deleted}; blocked ${result.blocked}.`,
          };
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: "Could not safely delete the reviewed tabs.",
          };
        }
      }
      case "cleanupToggle": {
        if (!deps.cleanup) return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        const next = !cleanupEnabled();
        try {
          await deps.cleanup.setAutomaticCleanup(next);
        } catch {
          return {
            ...cleanupLayer(),
            ok: false,
            alert: "Could not change the cleanup setting.",
          };
        }
        return {
          ...cleanupLayer(),
          alert: next ? "Tabs delete on graceful quit." : "Tabs are preserved on quit.",
        };
      }
      case "list":
        return rosterLayer();
      case "browse":
        if (!deps.browse) return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        return deps.browse(command.path);
      case "attach": {
        const worker = deps.workers.get(command.workerId);
        if (!worker) return { ok: false, html: NOTICE_UNKNOWN_WORKER };
        const result = deps.routes.set({
          target: context.target,
          workerId: worker.workerId,
          registrationGeneration: worker.registrationGeneration,
          epoch: context.epoch,
          ...(context.nowMs !== undefined ? { nowMs: context.nowMs } : {}),
        });
        if (!result.ok) {
          return { ok: false, html: "⚠️ **Could not attach the Pi worker.**" };
        }
        return {
          ok: true,
          html: `✅ **Attached this thread to <code>${escapeTelegramHtml(worker.workerId)}</code>.**`,
        };
      }
      case "detach": {
        const cleared = deps.routes.clear({
          target: context.target,
          epoch: context.epoch,
        });
        return cleared
          ? { ok: true, html: "✅ **Detached this thread.**" }
          : { ok: true, html: "ℹ️ **This thread had no Pi worker.**" };
      }
      case "stopAsk": {
        const worker = deps.workers.get(command.workerId);
        if (!worker) return { ok: false, html: NOTICE_UNKNOWN_WORKER };
        const label = escapeTelegramHtml(resolveTelegramWorkerLabel(worker));
        return {
          ok: true,
          html: `🛑 <b>Stop ${label}?</b>\n<i>Its Telegram Thread stays; the worker process ends.</i>`,
          keyboard: {
            inline_keyboard: [
              [
                {
                  text: "🛑 Stop",
                  callback_data: `${TELEGRAM_WORKER_MENU_CALLBACKS.stop}${worker.workerId}`,
                },
              ],
              [
                {
                  text: "↩️ Back",
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
          return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
        }
        // A stale button for a worker that already left reports that plainly instead
        // of asking the supervisor to act on an unknown target.
        if (command.kind !== "start" && !deps.workers.get(command.workerId)) {
          return { ok: false, html: NOTICE_UNKNOWN_WORKER };
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
          return { ok: false, html: NOTICE_MANAGED_UNAVAILABLE };
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
