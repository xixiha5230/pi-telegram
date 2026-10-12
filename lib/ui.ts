/**
 * Telegram UI primitives
 * Zones: telegram UI, presentation
 * Owns small, locale-aware presentation helpers shared by every menu surface:
 * hero headers, breadcrumbs, toggle rows, and confirmation copy. It renders HTML
 * strings and button descriptors only; it owns no callbacks, state, or transport.
 */

import {
  type TelegramLocale,
  type TelegramTranslator,
  createTelegramTranslator,
  t,
} from "./i18n.ts";
import {
  type TelegramStatusLabels,
} from "./status.ts";

export interface TelegramUiButton {
  text: string;
  callback_data: string;
}

/**
 * A short, phone-readable hero: one bold title, an optional blockquote pitch,
 * and an optional italic meta line. This is the recommended `/start` header.
 */
export function buildTelegramHeroHtml(input: {
  title: string;
  subtitle?: string;
  tip?: string;
}): string {
  const lines = [`<b>${escapeTelegramUiHtml(input.title)}</b>`];
  if (input.subtitle) {
    lines.push("", `<blockquote>${escapeTelegramUiHtml(input.subtitle)}</blockquote>`);
  }
  if (input.tip) lines.push("", `<i>${escapeTelegramUiHtml(input.tip)}</i>`);
  return lines.join("\n");
}

/** A breadcrumb line such as `⚙️ Settings · home › settings`. */
export function buildTelegramBreadcrumbHtml(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  const [head, ...rest] = parts;
  const tail = rest.length > 0 ? ` · ${rest.join(" › ")}` : "";
  return `<b>${escapeTelegramUiHtml(head)}</b>${escapeTelegramUiHtml(tail)}`;
}

/**
 * Toggle label: the label states the current value, so one tap flips it and the
 * label change is the feedback. On uses `✅`, off uses `⬜`.
 */
export function formatTelegramToggleButtonLabel(
  label: string,
  on: boolean,
): string {
  return `${on ? "✅" : "⬜"} ${label}`;
}

/** A vertical toggle row for a settings list. */
export function buildTelegramToggleRow(
  label: string,
  on: boolean,
  callbackData: string,
): TelegramUiButton {
  return { text: formatTelegramToggleButtonLabel(label, on), callback_data: callbackData };
}

/** Confirmation copy: restate the impact, then the safe/destructive actions. */
export function buildTelegramConfirmationHtml(input: {
  title: string;
  impact: string;
}): string {
  return [
    `<b>${escapeTelegramUiHtml(input.title)}</b>`,
    "",
    `<blockquote>${escapeTelegramUiHtml(input.impact)}</blockquote>`,
  ].join("\n");
}

/** A friendly empty state with an explicit call to action. */
export function buildTelegramEmptyStateHtml(input: {
  title: string;
  body: string;
}): string {
  return [
    `<b>${escapeTelegramUiHtml(input.title)}</b>`,
    "",
    `<blockquote>${escapeTelegramUiHtml(input.body)}</blockquote>`,
  ].join("\n");
}

/** Standard back-to-main-menu row. */
export function buildTelegramMainMenuRow(
  translate: TelegramTranslator = createTelegramTranslator("en"),
): TelegramUiButton {
  return { text: translate("common.mainMenu"), callback_data: "menu:back" };
}

/** Standard one-level-back row. */
export function buildTelegramBackRow(
  callbackData: string,
  translate: TelegramTranslator = createTelegramTranslator("en"),
): TelegramUiButton {
  return { text: translate("common.back"), callback_data: callbackData };
}

/** Minimal HTML escaping for Telegram HTML parse mode. */
export function escapeTelegramUiHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function telegramUiTranslator(locale: TelegramLocale): TelegramTranslator {
  return createTelegramTranslator(locale);
}

/** Localized status row labels for the given locale. */
export function getTelegramStatusLabels(
  locale: TelegramLocale,
): TelegramStatusLabels {
  return {
    status: t(locale, "status.row.status"),
    tokens: t(locale, "status.row.tokens"),
    cache: t(locale, "status.row.cache"),
    cost: t(locale, "status.row.cost"),
    context: t(locale, "status.row.context"),
  };
}

/** A label getter bound to a locale getter, for the status HTML builder. */
export function createTelegramStatusLabelsGetter(
  getLocale: () => TelegramLocale,
): () => TelegramStatusLabels {
  return () => getTelegramStatusLabels(getLocale());
}
