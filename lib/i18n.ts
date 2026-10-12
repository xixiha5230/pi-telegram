/**
 * Telegram bridge internationalization
 * Zones: telegram UI, localization
 * Owns the locale set, the message catalog, locale resolution from Telegram
 * language codes, and interpolation. It holds no transport or runtime state, so
 * every UI owner can translate through one explicit locale value.
 */

/** Supported UI locales. Add a locale here and its catalog below. */
export type TelegramLocale = "en" | "zh-CN";

export const TELEGRAM_DEFAULT_LOCALE: TelegramLocale = "en";

export const TELEGRAM_SUPPORTED_LOCALES: readonly TelegramLocale[] = [
  "en",
  "zh-CN",
];

/** Telegram `language_code` values that map onto each supported locale. */
const TELEGRAM_LOCALE_ALIASES: Record<string, TelegramLocale> = {
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hans-cn": "zh-CN",
  "zh-sg": "zh-CN",
};

export function isTelegramLocale(value: unknown): value is TelegramLocale {
  return (
    typeof value === "string" &&
    (TELEGRAM_SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Resolve a Telegram `User.language_code` (or a configured locale) to a
 * supported locale. Unknown, empty, or malformed codes fall back to the
 * default. A region-qualified code resolves by exact alias first, then by its
 * primary subtag, so `zh-TW` maps to the `zh` family and `de-AT` stays default.
 */
export function resolveTelegramLocale(
  languageCode: string | undefined | null,
): TelegramLocale {
  if (typeof languageCode !== "string") return TELEGRAM_DEFAULT_LOCALE;
  const normalized = languageCode.trim().toLowerCase();
  if (normalized.length === 0) return TELEGRAM_DEFAULT_LOCALE;
  const exact = TELEGRAM_LOCALE_ALIASES[normalized];
  if (exact) return exact;
  const primary = normalized.split(/[-_]/u)[0];
  return TELEGRAM_LOCALE_ALIASES[primary] ?? TELEGRAM_DEFAULT_LOCALE;
}

/**
 * English source catalog. Every key is authored here; other locales override a
 * subset and fall back to English. `{name}` placeholders are interpolated.
 */
const TELEGRAM_MESSAGES_EN = {
  "common.back": "⬆️ Back",
  "common.mainMenu": "⬆️ Main menu",
  "common.home": "🏠 Home",
  "common.close": "✖️ Close",
  "common.cancel": "❌ Cancel",
  "common.confirm": "✅ Confirm",
  "common.on": "on",
  "common.off": "off",
  "common.loading": "⏳ Working…",

  "command.start": "Open menu / Pair bridge",
  "command.compact": "Compact current session",
  "command.new": "Start a new session",
  "command.sessions": "List or switch sessions",
  "command.continue": "Queue continue prompt",
  "command.next": "Force next turn",
  "command.abort": "Abort Pi",
  "command.stop": "Abort Pi & Clear queue",

  "menu.title": "Pi Telegram",
  "menu.subtitle":
    "Button-first control for a live Pi session. Tap a tile; nothing here needs a typed command.",
  "menu.tip": "Tip: navigate by tapping — the panel rewrites in place.",
  "menu.section.actions": "Session",
  "menu.section.model": "Model",
  "menu.section.settings": "Preferences",
  "menu.openStatus": "📊 Status",
  "menu.openQueue": "🔢 Queue",
  "menu.openModel": "🤖 Model",
  "menu.openThinking": "🧠 Thinking",
  "menu.openSettings": "⚙️ Settings",

  "settings.title": "⚙️ Settings",
  "settings.subtitle": "Toggle a row to flip it; the panel updates in place.",
  "settings.draftPreviews": "📝 Draft previews",
  "settings.rendering": "🧾 Rendering",
  "settings.voiceReply": "👄 Voice reply",
  "settings.activity": "🔬 Activity",
  "settings.timeInjection": "🕒 Time injection",
  "settings.threadCleanup": "🧹 Thread cleanup",
  "settings.threadDisplay": "🧵 Thread display",
  "settings.language": "🌐 Language",

  "model.title": "🤖 Choose a model",
  "model.pageTitle": "Choose a page",
  "model.detailTitle": "🤖 Model",
  "thinking.title": "🧠 Choose a thinking level",
  "queue.title": "🔢 Queue",
  "queue.empty": "Nothing is waiting in the queue.",
  "status.title": "📊 Status",
  "daemon.title": "🛠️ Daemon control",
  "daemon.subtitle": "Pick an action below.",
  "daemon.workers": "👷 Workers",
  "daemon.newWorker": "📁 New worker…",
  "daemon.status": "ℹ️ Status",
  "daemon.threads": "🧹 Threads",
  "daemon.menu": "↩️ Menu",
  "daemon.close": "✖️ Close",
  "status.row.status": "Status",
  "status.row.tokens": "Tokens",
  "status.row.cache": "Cache",
  "status.row.cost": "Cost",
  "status.row.context": "Context",
  "sessions.title": "🗂 Sessions",
} as const;

export type TelegramMessageKey = keyof typeof TELEGRAM_MESSAGES_EN;

/** Locale overrides. Missing keys fall back to English. */
const TELEGRAM_MESSAGES_ZH_CN: Partial<Record<TelegramMessageKey, string>> = {
  "common.back": "⬆️ 返回",
  "common.mainMenu": "⬆️ 主菜单",
  "common.home": "🏠 首页",
  "common.close": "✖️ 关闭",
  "common.cancel": "❌ 取消",
  "common.confirm": "✅ 确认",
  "common.on": "开",
  "common.off": "关",
  "common.loading": "⏳ 处理中…",

  "command.start": "打开菜单 / 配对连接",
  "command.compact": "压缩当前会话",
  "command.new": "开始新会话",
  "command.sessions": "列出或切换会话",
  "command.continue": "加入继续提示",
  "command.next": "强制下一轮",
  "command.abort": "中止 Pi",
  "command.stop": "中止 Pi 并清空队列",

  "menu.title": "Pi Telegram",
  "menu.subtitle": "面向实时 Pi 会话的按钮式控制台。点按卡片即可，无需输入命令。",
  "menu.tip": "提示：点按导航，面板会原地刷新。",
  "menu.section.actions": "会话",
  "menu.section.model": "模型",
  "menu.section.settings": "偏好",
  "menu.openStatus": "📊 状态",
  "menu.openQueue": "🔢 队列",
  "menu.openModel": "🤖 模型",
  "menu.openThinking": "🧠 思考",
  "menu.openSettings": "⚙️ 设置",

  "settings.title": "⚙️ 设置",
  "settings.subtitle": "点按一行即可切换，面板会原地更新。",
  "settings.draftPreviews": "📝 草稿预览",
  "settings.rendering": "🧾 渲染方式",
  "settings.voiceReply": "👄 语音回复",
  "settings.activity": "🔬 活动",
  "settings.timeInjection": "🕒 时间注入",
  "settings.threadCleanup": "🧹 会话清理",
  "settings.threadDisplay": "🧵 会话显示",
  "settings.language": "🌐 语言",

  "model.title": "🤖 选择模型",
  "model.pageTitle": "选择页码",
  "model.detailTitle": "🤖 模型",
  "thinking.title": "🧠 选择思考等级",
  "queue.title": "🔢 队列",
  "queue.empty": "队列中没有等待的任务。",
  "status.title": "📊 状态",
  "daemon.title": "🛠️ 守护进程控制",
  "daemon.subtitle": "请选择下面的操作。",
  "daemon.workers": "👷 工作进程",
  "daemon.newWorker": "📁 新建工作进程…",
  "daemon.status": "ℹ️ 状态",
  "daemon.threads": "🧹 会话",
  "daemon.menu": "↩️ 菜单",
  "daemon.close": "✖️ 关闭",
  "status.row.status": "状态",
  "status.row.tokens": "Token",
  "status.row.cache": "缓存",
  "status.row.cost": "费用",
  "status.row.context": "上下文",
  "sessions.title": "🗂 会话",
};

const TELEGRAM_MESSAGE_CATALOGS: Record<
  TelegramLocale,
  Partial<Record<TelegramMessageKey, string>>
> = {
  en: TELEGRAM_MESSAGES_EN,
  "zh-CN": TELEGRAM_MESSAGES_ZH_CN,
};

/** Interpolate `{name}` placeholders with string/number values. */
export function interpolateTelegramMessage(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate a key for a locale. Missing locale entries fall back to English;
 * an unknown key returns the key itself so a missing translation is visible
 * instead of throwing inside a render path.
 */
export function t(
  locale: TelegramLocale,
  key: TelegramMessageKey,
  params?: Record<string, string | number>,
): string {
  const catalog = TELEGRAM_MESSAGE_CATALOGS[locale];
  const template = catalog[key] ?? TELEGRAM_MESSAGES_EN[key] ?? key;
  return interpolateTelegramMessage(template, params);
}

/** A locale-bound translator, convenient for render deps. */
export function createTelegramTranslator(
  locale: TelegramLocale,
): (key: TelegramMessageKey, params?: Record<string, string | number>) => string {
  return (key, params) => t(locale, key, params);
}

export type TelegramTranslator = ReturnType<typeof createTelegramTranslator>;

/** Format a setting state value using the locale's on/off words. */
export function formatTelegramToggleState(
  locale: TelegramLocale,
  on: boolean,
): string {
  return t(locale, on ? "common.on" : "common.off");
}

/**
 * Best-effort extraction of the sender's Telegram language code from any update
 * carrier that can start a turn. Returns undefined for shapes without a sender.
 */
export function getTelegramUpdateLanguageCode(
  update: unknown,
): string | undefined {
  if (!update || typeof update !== "object") return undefined;
  const record = update as Record<string, unknown>;
  for (const carrier of [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "callback_query",
    "inline_query",
    "chosen_inline_result",
    "business_message",
  ]) {
    const value = record[carrier];
    if (!value || typeof value !== "object") continue;
    const from = (value as Record<string, unknown>).from;
    if (!from || typeof from !== "object") continue;
    const languageCode = (from as Record<string, unknown>).language_code;
    if (typeof languageCode === "string" && languageCode.length > 0) {
      return languageCode;
    }
  }
  return undefined;
}
