/**
 * Worker directory browser
 * Zones: daemon control plane, telegram controls
 * Owns the Telegram inline directory picker used to launch a managed worker
 * without typing a path. Callback tokens are short, bounded, and expiring; the
 * browser never holds a Telegram client and never spawns anything itself.
 */

import { TELEGRAM_DEFAULT_LOCALE, t, type TelegramLocale } from "./i18n.ts";

export interface TelegramWorkerInlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface TelegramWorkerBrowserListing {
  path: string;
  parent?: string;
  token: string;
  entries: readonly { name: string; path: string }[];
}

export interface TelegramWorkerBrowserReply {
  ok: boolean;
  html: string;
  keyboard?: TelegramWorkerInlineKeyboard;
  alert?: string;
}

export interface TelegramWorkerBrowserPorts {
  listDirectories: (path: string) => readonly string[];
  resolveDirectory: (path: string) => string | undefined;
  onStart: (path: string) => { ok: boolean; message: string };
  root: string;
  maxEntries?: number;
  tokenTtlMs?: number;
  now?: () => number;
  /** Resolved UI locale for this profile. Defaults to English when absent. */
  getLocale?: () => TelegramLocale;
}

export interface TelegramWorkerDirectoryBrowser {
  open: (path?: string) => TelegramWorkerBrowserReply;
  navigate: (callbackData: string) => TelegramWorkerBrowserReply;
  keyboardForList: () => TelegramWorkerInlineKeyboard;
}

export const TELEGRAM_WORKER_CALLBACK_PREFIX = "ptw:";

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function createTelegramWorkerDirectoryBrowser(
  ports: TelegramWorkerBrowserPorts,
): TelegramWorkerDirectoryBrowser {
  const now = ports.now ?? Date.now;
  const locale = (): TelegramLocale =>
    ports.getLocale?.() ?? TELEGRAM_DEFAULT_LOCALE;
  const maxEntries = ports.maxEntries ?? 30;
  const tokenTtlMs = ports.tokenTtlMs ?? 10 * 60_000;
  const listings = new Map<string, { path: string; entries: string[]; expiresAtMs: number }>();

  const mintToken = (): string => {
    let token = "";
    for (let index = 0; index < 6; index += 1) {
      token += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
    }
    return token;
  };

  const prune = (): void => {
    const current = now();
    for (const [token, entry] of listings) {
      if (entry.expiresAtMs <= current) listings.delete(token);
    }
  };

  const renderListing = (listing: TelegramWorkerBrowserListing): TelegramWorkerBrowserReply => {
    const keyboard: { text: string; callback_data: string }[][] = [];
    if (listing.parent !== undefined) {
      keyboard.push([{ text: t(locale(), "daemon.browser.up"), callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}u:${listing.token}` }]);
    }
    const entryRow: { text: string; callback_data: string }[] = [];
    listing.entries.forEach((entry, index) => {
      entryRow.push({
        text: `📁 ${entry.name}`.slice(0, 60),
        callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}o:${listing.token}:${index}`,
      });
    });
    for (let index = 0; index < entryRow.length; index += 2) {
      keyboard.push(entryRow.slice(index, index + 2));
    }
    keyboard.push([
      { text: t(locale(), "daemon.browser.startHere"), callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}s:${listing.token}` },
    ]);
    keyboard.push([
      { text: t(locale(), "daemon.back"), callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}c` },
    ]);
    const body = listing.entries.length
      ? listing.entries.map((entry) => `📁 ${escapeHtml(entry.name)}`).join("\n")
      : t(locale(), "daemon.browser.empty");
    return {
      ok: true,
      html: `<b>${t(locale(), "daemon.browser.title")}</b>\n<code>${escapeHtml(listing.path)}</code>\n\n${body}`,
      keyboard: { inline_keyboard: keyboard },
    };
  };

  const open = (path?: string): TelegramWorkerBrowserReply => {
    prune();
    const requested = path ?? ports.root;
    const resolved = ports.resolveDirectory(requested);
    if (!resolved) {
      return { ok: false, html: `${t(locale(), "daemon.browser.notDirectory")} <code>${escapeHtml(requested)}</code>` };
    }
    let names: readonly string[];
    try {
      names = ports.listDirectories(resolved);
    } catch {
      return { ok: false, html: `${t(locale(), "daemon.browser.cannotRead")} <code>${escapeHtml(resolved)}</code>` };
    }
    const visible = [...names]
      .filter((name) => !name.startsWith("."))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, maxEntries);
    const entries = visible.map((name) => ({
      name,
      path: resolved.endsWith("/") ? `${resolved}${name}` : `${resolved}/${name}`,
    }));
    const token = mintToken();
    listings.set(token, {
      path: resolved,
      entries: entries.map((entry) => entry.path),
      expiresAtMs: now() + tokenTtlMs,
    });
    const parent = resolved === "/" ? undefined : resolved.replace(/\/[^/]+$/u, "") || "/";
    return renderListing({ path: resolved, parent, token, entries });
  };

  const navigate = (callbackData: string): TelegramWorkerBrowserReply => {
    prune();
    if (!callbackData.startsWith(TELEGRAM_WORKER_CALLBACK_PREFIX)) {
      return { ok: false, html: t(locale(), "daemon.browser.unknownAction") };
    }
    const parts = callbackData.slice(TELEGRAM_WORKER_CALLBACK_PREFIX.length).split(":");
    const op = parts[0] ?? "";
    if (op === "b") return open(ports.root);
    const token = parts[1] ?? "";
    const entry = listings.get(token);
    if (!entry) return { ok: false, html: t(locale(), "daemon.browser.expired") };
    if (op === "u") {
      const parent = entry.path.replace(/\/[^/]+$/u, "") || "/";
      return open(parent);
    }
    if (op === "o") {
      const index = Number.parseInt(parts[2] ?? "", 10);
      const child = Number.isSafeInteger(index) ? entry.entries[index] : undefined;
      if (!child) return { ok: false, html: t(locale(), "daemon.browser.expired") };
      return open(child);
    }
    if (op === "s") {
      const result = ports.onStart(entry.path);
      return {
        ok: result.ok,
        html: `${result.ok ? "✅" : "⚠️"} **${escapeHtml(result.message)}**`,
        alert: result.message,
        keyboard: result.ok
          ? {
              inline_keyboard: [
                [
                  {
                    text: t(locale(), "daemon.workersBack"),
                    callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}w`,
                  },
                ],
              ],
            }
          : undefined,
      };
    }
    return { ok: false, html: t(locale(), "daemon.browser.unknownAction") };
  };

  return {
    open,
    navigate,
    keyboardForList: () => ({
      inline_keyboard: [
        [
          { text: t(locale(), "daemon.newWorker"), callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}b` },
          { text: t(locale(), "daemon.menu"), callback_data: `${TELEGRAM_WORKER_CALLBACK_PREFIX}m` },
        ],
      ],
    }),
  };
}
