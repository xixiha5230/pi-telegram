/**
 * Telegram settings menu UI helpers
 * Zones: telegram ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */

import type {
  TelegramActivityVerbosity,
  TelegramAssistantRenderingMode,
  TelegramTimeMode,
  TelegramThreadDisplayMode,
} from "./config.ts";
import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramModelMenuState } from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import {
  getTelegramExtensionSettingsRows,
  type TelegramSectionRegistry,
} from "./sections.ts";
import type { TelegramVoiceReplyMode } from "./voice.ts";
import {
  isTelegramLocale,
  TELEGRAM_DEFAULT_LOCALE,
  TELEGRAM_SUPPORTED_LOCALES,
  t,
  type TelegramLocale,
} from "./i18n.ts";
import {
  buildTelegramBreadcrumbHtml,
  buildTelegramMainMenuRow,
  formatTelegramToggleButtonLabel,
  telegramUiTranslator,
} from "./ui.ts";

export type TelegramSettingsMenuReplyMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramSettingsStateDeps {
  getThreadDisplayMode?: () => TelegramThreadDisplayMode | undefined;
  isThreadDisplayCustom?: () => boolean;
  areDraftPreviewsEnabled: () => boolean;
  getAssistantRenderingMode: () => TelegramAssistantRenderingMode;
  getActivityVerbosity: () => TelegramActivityVerbosity;
  getTimeInjectionMode: () => TelegramTimeMode;
  getVoiceReplyMode: () => TelegramVoiceReplyMode;
  isVoiceReplyModeConfigured: () => boolean;
  isAutomaticThreadCleanupEnabled: () => boolean;
  /** Resolved UI locale for this profile. Defaults to English when absent. */
  getLocale?: () => TelegramLocale;
}

export interface TelegramSettingsMutationDeps extends TelegramSettingsStateDeps {
  setThreadDisplayMode?: (mode: TelegramThreadDisplayMode) => Promise<void>;
  setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
  setAssistantRenderingMode: (
    mode: TelegramAssistantRenderingMode,
  ) => Promise<void>;
  setActivityVerbosity: (
    verbosity: TelegramActivityVerbosity,
  ) => Promise<void>;
  setVoiceReplyMode: (
    mode: TelegramVoiceReplyMode | undefined,
  ) => Promise<void>;
  setTimeInjectionMode: (mode: TelegramTimeMode) => Promise<void>;
  setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
  /** Persist an explicit UI locale override. */
  setLocale?: (locale: TelegramLocale) => void | Promise<void>;
  reviewInactiveThreads?: () => Promise<{ count: number; operationId?: string }>;
  cleanInactiveThreads?: (operationId: string) => Promise<{
    deleted: number; outcomeUnknown: number; blocked?: number;
    recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
  }>;
}

export interface TelegramSettingsMenuOpenDeps<
  TModel extends MenuModel = MenuModel,
> extends TelegramSettingsStateDeps {
  getModelMenuState: () => Promise<TelegramModelMenuState<TModel>>;
  sendSettingsMenu: (
    state: TelegramModelMenuState<TModel>,
    text: string,
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<number | undefined>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
}

export interface TelegramSettingsMenuCallbackDeps extends TelegramSettingsMutationDeps {
  updateSettingsMessage: (
    text: string,
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  sectionRegistry?: TelegramSectionRegistry;
}

export interface TelegramSettingsMenuRuntime<TContext> {
  openSettingsMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: {
      id: string;
      data?: string;
      message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: { id?: number };
      };
    },
    ctx: TContext,
  ) => Promise<boolean>;
  updateSettingsMenuMessage: (
    state: TelegramModelMenuState,
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramSettingsMenuMessageUpdateDeps extends TelegramSettingsStateDeps {
  updateSettingsMessage: (
    text: string,
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<void>;
}

export interface TelegramSettingsMenuRuntimeDeps<
  TContext,
  TModel extends MenuModel = MenuModel,
> extends TelegramSettingsMutationDeps {
  reloadConfig?: () => Promise<void>;
  getModelMenuState: (
    chatId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<TelegramModelMenuState<TModel>>;
  getStoredModelMenuState: (
    messageId: number | undefined,
    chatId?: number,
  ) => TelegramModelMenuState<TModel> | undefined;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramSettingsMenuReplyMarkup,
  ) => Promise<number | undefined>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
}

export const SETTINGS_MENU_TITLE = "<b>⚙️ Settings:</b>";
export const AUTOMATIC_THREAD_CLEANUP_SETTINGS_TITLE =
  "<b>🧹 Thread cleanup:</b>";
export const INACTIVE_THREAD_REVIEW_TITLE = "<b>🔎 Inactive tabs review:</b>";
export const DRAFT_PREVIEWS_SETTINGS_TITLE = "<b>📝 Draft previews:</b>";
export const ASSISTANT_RENDERING_SETTINGS_TITLE =
  "<b>🧾 Assistant rendering:</b>";
export const ACTIVITY_VERBOSITY_SETTINGS_TITLE =
  "<b>🔬 Activity:</b>";
export const TIME_INJECTION_MODE_SETTINGS_TITLE =
  "<b>🕒 Time injection mode:</b>";
export const VOICE_REPLY_MODE_SETTINGS_TITLE = "<b>👄 Voice reply mode:</b>";
export const THREAD_DISPLAY_SETTINGS_TITLE = "<b>🧵 Thread display:</b>";

function getVoiceReplyModeLabel(mode: TelegramVoiceReplyMode): string {
  return mode;
}

function getTelegramSettingsStateValueLabel(value: string): string {
  return value.toLowerCase();
}

function getVoiceReplyModeSetting(
  mode: TelegramVoiceReplyMode,
  configured: boolean,
): TelegramVoiceReplyMode {
  return configured ? mode : "manual";
}

export function buildTelegramSettingsMenuText(
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    buildTelegramBreadcrumbHtml([t(locale, "settings.title"), "home", "settings"]),
    "",
    `<blockquote>${t(locale, "settings.subtitle")}</blockquote>`,
  ].join("\n");
}

export function buildThreadDisplaySettingsText(
  mode: TelegramThreadDisplayMode,
  custom = false,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.threadDisplay")}:</b> <code>${custom ? "custom" : threadDisplayModeLabel(mode)}</code>`,
    "",
    t(locale, "settings.threadDisplay.intro"),
    "",
    t(locale, "settings.threadDisplay.nameHint"),
    "",
    t(locale, "settings.threadDisplay.letters"),
    t(locale, "settings.threadDisplay.names"),
    t(locale, "settings.threadDisplay.directoryTitle"),
    t(locale, "settings.threadDisplay.directorySnake"),
    t(locale, "settings.threadDisplay.state"),
  ].join("\n");
}

export function buildAutomaticThreadCleanupSettingsText(
  enabled: boolean,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.threadCleanup")}:</b> <code>${enabled ? "on" : "off"}</code>`,
    "",
    t(locale, "settings.cleanup.intro"),
    "",
    t(locale, "settings.cleanup.on"),
    t(locale, "settings.cleanup.off"),
    "",
    t(locale, "settings.cleanup.reviewNote"),
  ].join("\n");
}

export function buildInactiveThreadReviewText(
  count: number,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.review.title")}:</b>`,
    "",
    t(locale, "settings.review.count", { count }),
    t(locale, "settings.review.noDelete"),
    t(locale, "settings.review.requiresConfirm"),
  ].join("\n");
}

export function buildInactiveThreadReviewReplyMarkup(
  operationId?: string,
  canCleanInactiveThreads = false,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const validOperationId = typeof operationId === "string" &&
    /^thread-cleanup:[a-f0-9]{32}$/u.test(operationId);
  return { inline_keyboard: [
    [{ text: t(locale, "settings.backToCleanup"),
      callback_data: "settings:open:automatic-thread-cleanup" }],
    ...(canCleanInactiveThreads && validOperationId ? [[{
      text: t(locale, "settings.cleanInactive"),
      callback_data: `settings:clean:${operationId}`,
    }]] : []),
  ] };
}

export function buildDraftPreviewsSettingsText(
  enabled: boolean,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.draftPreviews")}:</b> <code>${enabled ? "on" : "off"}</code>`,
    "",
    t(locale, "settings.draftPreviews.intro"),
    "",
    t(locale, "settings.draftPreviews.on"),
    t(locale, "settings.draftPreviews.off"),
  ].join("\n");
}

export function buildAssistantRenderingSettingsText(
  mode: TelegramAssistantRenderingMode,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.rendering")}:</b> <code>${mode}</code>`,
    "",
    t(locale, "settings.rendering.intro"),
    "",
    t(locale, "settings.rendering.rich"),
    t(locale, "settings.rendering.html"),
  ].join("\n");
}

export function buildActivityVerbositySettingsText(
  verbosity: TelegramActivityVerbosity,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.activity")}:</b> <code>${verbosity}</code>`,
    "",
    t(locale, "settings.activity.intro"),
    "",
    t(locale, "settings.activity.quiet"),
    t(locale, "settings.activity.thinking"),
    t(locale, "settings.activity.tools"),
    t(locale, "settings.activity.verbose"),
  ].join("\n");
}

export function buildVoiceReplyModeSettingsText(
  mode: TelegramVoiceReplyMode,
  configured = true,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.voiceReply")}:</b> <code>${getVoiceReplyModeLabel(
      getVoiceReplyModeSetting(mode, configured),
    )}</code>`,
    "",
    t(locale, "settings.voiceReply.intro"),
    "",
    t(locale, "settings.voiceReply.manual"),
    t(locale, "settings.voiceReply.mirror"),
    t(locale, "settings.voiceReply.always"),
  ].join("\n");
}

export function buildTimeInjectionModeSettingsText(
  mode: TelegramTimeMode,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.timeInjection")}:</b> <code>${mode}</code>`,
    "",
    t(locale, "settings.timeInjection.intro"),
    "",
    t(locale, "settings.timeInjection.hidden"),
    t(locale, "settings.timeInjection.always"),
    t(locale, "settings.timeInjection.interval"),
  ].join("\n");
}

export function buildTelegramSettingsMenuReplyMarkup(
  draftPreviewsEnabled: boolean,
  assistantRenderingModeOrVoiceReplyMode:
    TelegramAssistantRenderingMode | TelegramVoiceReplyMode,
  voiceReplyModeOrTimeInjectionMode: TelegramVoiceReplyMode | TelegramTimeMode,
  timeInjectionModeOrSectionRegistry?:
    TelegramTimeMode | TelegramSectionRegistry,
  sectionRegistryOrVoiceReplyModeConfigured?: TelegramSectionRegistry | boolean,
  voiceReplyModeConfigured = true,
  automaticThreadCleanupEnabled = true,
  activityVerbosity: TelegramActivityVerbosity = "quiet",
  threadDisplayMode?: TelegramThreadDisplayMode,
  threadDisplayCustom = false,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const hasRenderingMode =
    assistantRenderingModeOrVoiceReplyMode === "rich" ||
    assistantRenderingModeOrVoiceReplyMode === "html";
  const assistantRenderingMode: TelegramAssistantRenderingMode =
    hasRenderingMode ? assistantRenderingModeOrVoiceReplyMode : "rich";
  const voiceReplyMode = hasRenderingMode
    ? (voiceReplyModeOrTimeInjectionMode as TelegramVoiceReplyMode)
    : (assistantRenderingModeOrVoiceReplyMode as TelegramVoiceReplyMode);
  const timeInjectionMode = hasRenderingMode
    ? (timeInjectionModeOrSectionRegistry as TelegramTimeMode)
    : (voiceReplyModeOrTimeInjectionMode as TelegramTimeMode);
  const sectionRegistry = hasRenderingMode
    ? (sectionRegistryOrVoiceReplyModeConfigured as
        TelegramSectionRegistry | undefined)
    : (timeInjectionModeOrSectionRegistry as
        TelegramSectionRegistry | undefined);
  const effectiveVoiceReplyModeConfigured = hasRenderingMode
    ? voiceReplyModeConfigured
    : typeof sectionRegistryOrVoiceReplyModeConfigured === "boolean"
      ? sectionRegistryOrVoiceReplyModeConfigured
      : true;
  const translate = telegramUiTranslator(locale);
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [buildTelegramMainMenuRow(translate)],
  ];
  const settingsButtons: Array<{ text: string; callback_data: string }> = [
    {
      text: formatTelegramToggleButtonLabel(
        t(locale, "settings.draftPreviews"),
        draftPreviewsEnabled,
      ),
      callback_data: "settings:open:draft-previews",
    },
    {
      text: `${t(locale, "settings.rendering")}: ${assistantRenderingMode}`,
      callback_data: "settings:open:assistant-rendering",
    },
    {
      text: `${t(locale, "settings.voiceReply")}: ${getTelegramSettingsStateValueLabel(
          getVoiceReplyModeLabel(
            getVoiceReplyModeSetting(
              voiceReplyMode,
              effectiveVoiceReplyModeConfigured,
            ),
          ),
        )}`,
      callback_data: "settings:open:voice-reply",
    },
    {
      text: `${t(locale, "settings.activity")}: ${activityVerbosity}`,
      callback_data: "settings:open:activity-verbosity",
    },
    {
      text: `${t(locale, "settings.timeInjection")}: ${getTelegramSettingsStateValueLabel(timeInjectionMode)}`,
      callback_data: "settings:open:time-injection",
    },
  ];
  if (threadDisplayMode) settingsButtons.push(
    {
      text: formatTelegramToggleButtonLabel(
        t(locale, "settings.threadCleanup"),
        automaticThreadCleanupEnabled,
      ),
      callback_data: "settings:open:automatic-thread-cleanup",
    },
    {
      text: `${t(locale, "settings.threadDisplay")}: ${threadDisplayCustom ? "custom" : threadDisplayMode}`,
      callback_data: "settings:open:thread-display",
    },
  );
  if (sectionRegistry) {
    const extensionRows = getTelegramExtensionSettingsRows(sectionRegistry);
    settingsButtons.push(
      ...extensionRows.map((row) => ({
        text: row.label,
        callback_data: row.callback_data,
      })),
    );
  }
  settingsButtons.push({
    text: `${t(locale, "settings.language")}: ${locale}`,
    callback_data: "settings:open:language",
  });
  rows.push(...settingsButtons.map((button) => [button]));
  return { inline_keyboard: rows };
}

export async function openTelegramSettingsMenu<
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramSettingsMenuOpenDeps<TModel>,
  sectionRegistry?: TelegramSectionRegistry,
): Promise<void> {
  const state = await deps.getModelMenuState();
  const messageId = await deps.sendSettingsMenu(
    state,
    buildTelegramSettingsMenuText(deps.getLocale?.()),
    buildTelegramSettingsMenuReplyMarkup(
      deps.areDraftPreviewsEnabled(),
      deps.getAssistantRenderingMode(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
      deps.isAutomaticThreadCleanupEnabled(),
      deps.getActivityVerbosity(),
      deps.getThreadDisplayMode?.(),
      deps.isThreadDisplayCustom?.() ?? false,
      deps.getLocale?.(),
    ),
  );
  if (messageId === undefined) return;
  state.messageId = messageId;
  state.mode = "settings";
  deps.storeModelMenuState(state);
}

function threadDisplayModeLabel(mode: TelegramThreadDisplayMode): string {
  switch (mode) {
    case "letters": return "letters";
    case "names": return "names";
    case "directory-title": return "directory-title";
    case "directory-snake": return "directory-snake";
    case "state": return "state";
    default: return "letters";
  }
}

export function buildLanguageSettingsText(
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): string {
  return [
    `<b>${t(locale, "settings.language")}:</b>`,
    "",
    `<blockquote>${t(locale, "settings.subtitle")}</blockquote>`,
  ].join("\n");
}

export function buildLanguageSettingsReplyMarkup(
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  return { inline_keyboard: [
    [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
    ...TELEGRAM_SUPPORTED_LOCALES.map((value) => [{
      text: `${value === locale ? "🟢 " : ""}${value}`,
      callback_data: `settings:set:language:${value}`,
    }]),
  ] };
}

export function buildThreadDisplaySettingsReplyMarkup(
  mode: TelegramThreadDisplayMode,
  custom = false,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  return { inline_keyboard: [
    [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
    ...(["letters", "names", "directory-title", "directory-snake", "state"] as const).map((value) => [{
      text: `${!custom && mode === value ? "🟢 " : ""}${threadDisplayModeLabel(value)}`,
      callback_data: `settings:set:thread-display:${value}`,
    }]),
  ] };
}

export function buildAutomaticThreadCleanupSettingsReplyMarkup(
  enabled: boolean,
  canReviewInactiveThreads = false,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const on = t(locale, "settings.toggleOn");
  const off = t(locale, "settings.toggleOff");
  return {
    inline_keyboard: [
      [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
      [
        {
          text: enabled ? `🟢 ${on}` : `⚫️ ${on}`,
          callback_data: "settings:set:automatic-thread-cleanup:on",
        },
        {
          text: enabled ? `⚫️ ${off}` : `🟡 ${off}`,
          callback_data: "settings:set:automatic-thread-cleanup:off",
        },
      ],
      ...(canReviewInactiveThreads ? [[{
        text: t(locale, "settings.reviewInactive"),
        callback_data: "settings:review:inactive-threads",
      }]] : []),
    ],
  };
}

export function buildDraftPreviewsSettingsReplyMarkup(
  enabled: boolean,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const on = t(locale, "settings.toggleOn");
  const off = t(locale, "settings.toggleOff");
  return {
    inline_keyboard: [
      [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
      [
        {
          text: enabled ? `🟢 ${on}` : `⚫️ ${on}`,
          callback_data: "settings:set:draft-previews:on",
        },
        {
          text: enabled ? `⚫️ ${off}` : `🟡 ${off}`,
          callback_data: "settings:set:draft-previews:off",
        },
      ],
    ],
  };
}

export function buildAssistantRenderingSettingsReplyMarkup(
  mode: TelegramAssistantRenderingMode,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const modes: TelegramAssistantRenderingMode[] = ["rich", "html"];
  return {
    inline_keyboard: [
      [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === mode ? "🟢 " : ""}${value}`,
          callback_data: `settings:set:assistant-rendering:${value}`,
        },
      ]),
    ],
  };
}

export function buildActivityVerbositySettingsReplyMarkup(
  verbosity: TelegramActivityVerbosity,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const button = (value: TelegramActivityVerbosity) => ({
    text: `${value === verbosity ? "🟢 " : ""}${value}`,
    callback_data: `settings:set:activity-verbosity:${value}`,
  });
  return {
    inline_keyboard: [
      [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
      [button("quiet")],
      [button("thinking"), button("tools")],
      [button("verbose")],
    ],
  };
}

export function buildTimeInjectionModeSettingsReplyMarkup(
  mode: TelegramTimeMode,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const modes: TelegramTimeMode[] = ["hidden", "always", "interval"];
  return {
    inline_keyboard: [
      [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === mode ? "🟢 " : ""}${value}`,
          callback_data: `settings:set:time-injection:${value}`,
        },
      ]),
    ],
  };
}

export function buildVoiceReplyModeSettingsReplyMarkup(
  mode: TelegramVoiceReplyMode,
  configured = true,
  locale: TelegramLocale = TELEGRAM_DEFAULT_LOCALE,
): TelegramSettingsMenuReplyMarkup {
  const activeMode = getVoiceReplyModeSetting(mode, configured);
  const modes: TelegramVoiceReplyMode[] = ["manual", "mirror", "always"];
  return {
    inline_keyboard: [
      [{ text: t(locale, "common.back"), callback_data: "settings:list" }],
      ...modes.map((value) => [
        {
          text: `${value === activeMode ? "🟢 " : ""}${getVoiceReplyModeLabel(value)}`,
          callback_data: `settings:set:voice-reply:${value}`,
        },
      ]),
    ],
  };
}

export async function updateTelegramSettingsMenuMessage(
  deps: TelegramSettingsMenuMessageUpdateDeps,
  sectionRegistry?: TelegramSectionRegistry,
): Promise<void> {
  await deps.updateSettingsMessage(
    buildTelegramSettingsMenuText(deps.getLocale?.()),
    buildTelegramSettingsMenuReplyMarkup(
      deps.areDraftPreviewsEnabled(),
      deps.getAssistantRenderingMode(),
      deps.getVoiceReplyMode(),
      deps.getTimeInjectionMode(),
      sectionRegistry,
      deps.isVoiceReplyModeConfigured(),
      deps.isAutomaticThreadCleanupEnabled(),
      deps.getActivityVerbosity(),
      deps.getThreadDisplayMode?.(),
      deps.isThreadDisplayCustom?.() ?? false,
      deps.getLocale?.(),
    ),
  );
}

export async function updateAutomaticThreadCleanupSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.isAutomaticThreadCleanupEnabled();
  await deps.updateSettingsMessage(
    buildAutomaticThreadCleanupSettingsText(enabled, deps.getLocale?.()),
    buildAutomaticThreadCleanupSettingsReplyMarkup(
      enabled,
      !!deps.reviewInactiveThreads,
      deps.getLocale?.(),
    ),
  );
}

export async function updateDraftPreviewsSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const enabled = deps.areDraftPreviewsEnabled();
  await deps.updateSettingsMessage(
    buildDraftPreviewsSettingsText(enabled, deps.getLocale?.()),
    buildDraftPreviewsSettingsReplyMarkup(enabled, deps.getLocale?.()),
  );
}

export async function updateAssistantRenderingSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getAssistantRenderingMode();
  await deps.updateSettingsMessage(
    buildAssistantRenderingSettingsText(mode, deps.getLocale?.()),
    buildAssistantRenderingSettingsReplyMarkup(mode, deps.getLocale?.()),
  );
}

export async function updateActivityVerbositySettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const verbosity = deps.getActivityVerbosity();
  await deps.updateSettingsMessage(
    buildActivityVerbositySettingsText(verbosity, deps.getLocale?.()),
    buildActivityVerbositySettingsReplyMarkup(verbosity, deps.getLocale?.()),
  );
}

export async function updateTimeInjectionModeSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getTimeInjectionMode();
  await deps.updateSettingsMessage(
    buildTimeInjectionModeSettingsText(mode, deps.getLocale?.()),
    buildTimeInjectionModeSettingsReplyMarkup(mode, deps.getLocale?.()),
  );
}

export async function updateVoiceReplyModeSettingsMessage(
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<void> {
  const mode = deps.getVoiceReplyMode();
  const configured = deps.isVoiceReplyModeConfigured();
  await deps.updateSettingsMessage(
    buildVoiceReplyModeSettingsText(mode, configured, deps.getLocale?.()),
    buildVoiceReplyModeSettingsReplyMarkup(mode, configured, deps.getLocale?.()),
  );
}

export async function handleTelegramSettingsMenuCallbackAction(
  callbackQueryId: string,
  data: string | undefined,
  deps: TelegramSettingsMenuCallbackDeps,
): Promise<boolean> {
  if (!data?.startsWith("settings:")) return false;
  if (data === "settings:open:language" || data.startsWith("settings:set:language:")) {
    if (data.startsWith("settings:set:language:")) {
      const next = data.slice("settings:set:language:".length);
      if (isTelegramLocale(next)) await deps.setLocale?.(next);
    }
    const current = deps.getLocale?.() ?? TELEGRAM_DEFAULT_LOCALE;
    await deps.updateSettingsMessage(
      buildLanguageSettingsText(current),
      buildLanguageSettingsReplyMarkup(current),
    );
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:thread-display" || data.startsWith("settings:set:thread-display:")) {
    if (!deps.getThreadDisplayMode?.() || !deps.setThreadDisplayMode) {
      await deps.answerCallbackQuery(callbackQueryId, "Thread display requires Threaded Mode and a connected instance.");
      return true;
    }
    if (data.startsWith("settings:set:thread-display:")) {
      const mode = data.slice("settings:set:thread-display:".length);
      if (mode !== "letters" && mode !== "names" &&
          mode !== "directory-snake" && mode !== "directory-title" &&
          mode !== "state") {
        await deps.answerCallbackQuery(callbackQueryId, "Unknown Thread display mode.");
        return true;
      }
      try {
        await deps.setThreadDisplayMode(mode);
      } catch {
        await deps.answerCallbackQuery(callbackQueryId, "Thread display was not fully applied. The preference may be saved; retry after checking the leader.");
        return true;
      }
    }
    const mode = deps.getThreadDisplayMode();
    if (!mode) {
      await deps.answerCallbackQuery(callbackQueryId, "Threaded Mode is no longer available.");
      return true;
    }
    await deps.updateSettingsMessage(
      buildThreadDisplaySettingsText(
        mode,
        deps.isThreadDisplayCustom?.() ?? false,
        deps.getLocale?.(),
      ),
      buildThreadDisplaySettingsReplyMarkup(
        mode,
        deps.isThreadDisplayCustom?.() ?? false,
        deps.getLocale?.(),
      ),
    );
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:list") {
    await updateTelegramSettingsMenuMessage(deps, deps.sectionRegistry);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:automatic-thread-cleanup") {
    await updateAutomaticThreadCleanupSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (
    data === "settings:open:proactive" ||
    data === "settings:set:proactive:on" ||
    data === "settings:set:proactive:off"
  ) {
    await updateTelegramSettingsMenuMessage(deps, deps.sectionRegistry);
    await deps.answerCallbackQuery(
      callbackQueryId,
      "Public assistant output is always delivered while Telegram is connected.",
    );
    return true;
  }
  if (
    data === "settings:open:draft-previews" ||
    data === "settings:open:rich-drafts"
  ) {
    await updateDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:assistant-rendering") {
    await updateAssistantRenderingSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:activity-verbosity") {
    await updateActivityVerbositySettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "settings:open:voice-reply") {
    await updateVoiceReplyModeSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (
    data === "settings:open:time-injection" ||
    data === "settings:open:time"
  ) {
    await updateTimeInjectionModeSettingsMessage(deps);
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data.startsWith("settings:set:voice-reply:")) {
    const mode = data.slice("settings:set:voice-reply:".length);
    if (
      mode === "manual" ||
      mode === "hidden" ||
      mode === "mirror" ||
      mode === "always"
    ) {
      const normalizedMode = mode === "hidden" ? "manual" : mode;
      await deps.setVoiceReplyMode(normalizedMode);
      await updateVoiceReplyModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Voice reply mode: ${normalizedMode}`,
      );
      return true;
    }
  }
  if (
    data.startsWith("settings:set:time-injection:") ||
    data.startsWith("settings:set:time:")
  ) {
    const mode = data.startsWith("settings:set:time-injection:")
      ? data.slice("settings:set:time-injection:".length)
      : data.slice("settings:set:time:".length);
    const normalizedMode = mode === "off" ? "hidden" : mode;
    if (
      normalizedMode === "hidden" ||
      normalizedMode === "always" ||
      normalizedMode === "interval"
    ) {
      await deps.setTimeInjectionMode(normalizedMode);
      await updateTimeInjectionModeSettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Time injection: ${normalizedMode}`,
      );
      return true;
    }
  }
  if (
    data === "settings:set:draft-previews:on" ||
    data === "settings:set:draft-previews:off" ||
    data === "settings:set:rich-drafts:on" ||
    data === "settings:set:rich-drafts:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setDraftPreviewsEnabled(enabled);
    await updateDraftPreviewsSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Draft previews ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  if (data.startsWith("settings:set:assistant-rendering:")) {
    const mode = data.slice("settings:set:assistant-rendering:".length);
    if (mode === "rich" || mode === "html") {
      await deps.setAssistantRenderingMode(mode);
      await updateAssistantRenderingSettingsMessage(deps);
      await deps.answerCallbackQuery(callbackQueryId, `Rendering: ${mode}`);
      return true;
    }
  }
  if (data.startsWith("settings:set:activity-verbosity:")) {
    const verbosity = data.slice("settings:set:activity-verbosity:".length);
    if (
      verbosity === "quiet" ||
      verbosity === "thinking" ||
      verbosity === "tools" ||
      verbosity === "verbose"
    ) {
      await deps.setActivityVerbosity(verbosity);
      await updateActivityVerbositySettingsMessage(deps);
      await deps.answerCallbackQuery(
        callbackQueryId,
        `Activity: ${verbosity}`,
      );
      return true;
    }
  }
  if (data === "settings:review:inactive-threads") {
    if (!deps.reviewInactiveThreads) {
      await deps.answerCallbackQuery(callbackQueryId, "Inactive tab review is unavailable.");
      return true;
    }
    try {
      const review = await deps.reviewInactiveThreads();
      if (review.count === 0) {
        await deps.answerCallbackQuery(callbackQueryId, "No proven inactive tabs.");
      } else {
        await deps.updateSettingsMessage(
          buildInactiveThreadReviewText(review.count, deps.getLocale?.()),
          buildInactiveThreadReviewReplyMarkup(
            review.operationId,
            !!deps.cleanInactiveThreads,
            deps.getLocale?.(),
          ),
        );
        await deps.answerCallbackQuery(callbackQueryId, "Review prepared. No tabs were deleted.");
      }
    } catch {
      await deps.answerCallbackQuery(callbackQueryId, "Could not safely review inactive tabs.");
    }
    return true;
  }
  if (data.startsWith("settings:clean:")) {
    const operationId = data.slice("settings:clean:".length);
    if (!/^thread-cleanup:[a-f0-9]{32}$/u.test(operationId) || !deps.cleanInactiveThreads) {
      await deps.answerCallbackQuery(callbackQueryId, "Cleanup confirmation is unavailable or stale.");
      return true;
    }
    try {
      const result = await deps.cleanInactiveThreads(operationId);
      await deps.answerCallbackQuery(callbackQueryId,
        `Deleted: ${result.deleted}. Outcome unknown: ${result.outcomeUnknown}.` +
      (result.blocked ? ` Blocked: ${result.blocked}.` : "") +
      (result.recovery === "commit-ready" ? " Recovery: safe local commit pending." :
        result.recovery === "deletion-outcome-unknown" ? " Recovery: deletion outcome unknown; no retry." :
        result.recovery === "authority-blocked" ? " Recovery: cleanup authority unavailable." : ""));
    } catch {
      await deps.answerCallbackQuery(callbackQueryId, "Cleanup could not be safely completed.");
    }
    return true;
  }
  if (
    data === "settings:set:automatic-thread-cleanup:on" ||
    data === "settings:set:automatic-thread-cleanup:off"
  ) {
    const enabled = data.endsWith(":on");
    await deps.setAutomaticThreadCleanupEnabled(enabled);
    await updateAutomaticThreadCleanupSettingsMessage(deps);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Thread cleanup ${enabled ? "enabled" : "disabled"}`,
    );
    return true;
  }
  await deps.answerCallbackQuery(callbackQueryId);
  return true;
}

export function createTelegramSettingsMenuRuntime<
  TContext,
  TModel extends MenuModel = MenuModel,
>(
  deps: TelegramSettingsMenuRuntimeDeps<TContext, TModel>,
  sectionRegistry?: TelegramSectionRegistry,
): TelegramSettingsMenuRuntime<TContext> {
  return {
    openSettingsMenu: async (chatId, _replyToMessageId, ctx) => {
      await deps.reloadConfig?.();
      return openTelegramSettingsMenu(
        {
          getModelMenuState: () => deps.getModelMenuState(chatId, ctx),
          areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
          getAssistantRenderingMode: deps.getAssistantRenderingMode,
          getActivityVerbosity: deps.getActivityVerbosity,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
          isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
          getThreadDisplayMode: deps.getThreadDisplayMode,
          isThreadDisplayCustom: deps.isThreadDisplayCustom,
          sendSettingsMenu: (state, text, replyMarkup) =>
            deps.sendInteractiveMessage(
              state.chatId,
              text,
              "html",
              replyMarkup,
            ),
          storeModelMenuState: deps.storeModelMenuState,
        },
        sectionRegistry,
      );
    },
    updateSettingsMenuMessage: async (state) => {
      await deps.reloadConfig?.();
      return updateTelegramSettingsMenuMessage(
        {
          areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
          getAssistantRenderingMode: deps.getAssistantRenderingMode,
          getActivityVerbosity: deps.getActivityVerbosity,
          getVoiceReplyMode: deps.getVoiceReplyMode,
          isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
          getTimeInjectionMode: deps.getTimeInjectionMode,
          isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
          getThreadDisplayMode: deps.getThreadDisplayMode,
          isThreadDisplayCustom: deps.isThreadDisplayCustom,
          updateSettingsMessage: (text, replyMarkup) =>
            deps.editInteractiveMessage(
              state.chatId,
              state.messageId,
              text,
              "html",
              replyMarkup,
            ),
        },
        sectionRegistry,
      );
    },
    handleCallbackQuery: async (query, ctx) => {
      if (!query.data?.startsWith("settings:")) return false;
      await deps.reloadConfig?.();
      const messageId = query.message?.message_id;
      const chatId = query.message?.chat?.id;
      let state = deps.getStoredModelMenuState(messageId, chatId);
      if (!state) {
        if (typeof messageId !== "number" || typeof chatId !== "number") {
          await deps.answerCallbackQuery(
            query.id,
            "Interactive message expired.",
          );
          return true;
        }
        state = await deps.getModelMenuState(
          chatId,
          ctx,
          query.message?.message_thread_id,
        );
        state.messageId = messageId;
        state.mode = "settings";
        deps.storeModelMenuState(state);
      }
      return handleTelegramSettingsMenuCallbackAction(query.id, query.data, {
        areDraftPreviewsEnabled: deps.areDraftPreviewsEnabled,
        getAssistantRenderingMode: deps.getAssistantRenderingMode,
        getActivityVerbosity: deps.getActivityVerbosity,
        getVoiceReplyMode: deps.getVoiceReplyMode,
        isVoiceReplyModeConfigured: deps.isVoiceReplyModeConfigured,
        getTimeInjectionMode: deps.getTimeInjectionMode,
        isAutomaticThreadCleanupEnabled: deps.isAutomaticThreadCleanupEnabled,
        getThreadDisplayMode: deps.getThreadDisplayMode,
        isThreadDisplayCustom: deps.isThreadDisplayCustom,
        setThreadDisplayMode: deps.setThreadDisplayMode,
        setDraftPreviewsEnabled: deps.setDraftPreviewsEnabled,
        setAssistantRenderingMode: deps.setAssistantRenderingMode,
        setActivityVerbosity: deps.setActivityVerbosity,
        setVoiceReplyMode: deps.setVoiceReplyMode,
        setTimeInjectionMode: deps.setTimeInjectionMode,
        setAutomaticThreadCleanupEnabled: deps.setAutomaticThreadCleanupEnabled,
        ...(deps.reviewInactiveThreads ? { reviewInactiveThreads: deps.reviewInactiveThreads } : {}),
        ...(deps.cleanInactiveThreads ? { cleanInactiveThreads: deps.cleanInactiveThreads } : {}),
        updateSettingsMessage: (text, replyMarkup) =>
          deps.editInteractiveMessage(
            state.chatId,
            state.messageId,
            text,
            "html",
            replyMarkup,
          ),
        answerCallbackQuery: deps.answerCallbackQuery,
        sectionRegistry,
      });
    },
  };
}
