/**
 * Regression tests for Telegram UI internationalization
 * Covers locale resolution, catalog fallback, interpolation, and command localization
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramTranslator,
  formatTelegramToggleState,
  getTelegramUpdateLanguageCode,
  interpolateTelegramMessage,
  isTelegramLocale,
  resolveTelegramLocale,
  TELEGRAM_DEFAULT_LOCALE,
  TELEGRAM_SUPPORTED_LOCALES,
  t,
} from "../lib/i18n.ts";
import {
  getTelegramBuiltinBotCommands,
  TELEGRAM_BOT_COMMANDS,
} from "../lib/commands.ts";
import {
  buildTelegramBreadcrumbHtml,
  buildTelegramHeroHtml,
  formatTelegramToggleButtonLabel,
  getTelegramStatusLabels,
} from "../lib/ui.ts";
import {
  buildLanguageSettingsReplyMarkup,
  buildLanguageSettingsText,
} from "../lib/menu-settings.ts";

test("i18n resolves Telegram language codes onto supported locales", () => {
  assert.equal(resolveTelegramLocale("en"), "en");
  assert.equal(resolveTelegramLocale("en-US"), "en");
  assert.equal(resolveTelegramLocale("zh"), "zh-CN");
  assert.equal(resolveTelegramLocale("zh-CN"), "zh-CN");
  assert.equal(resolveTelegramLocale("zh-Hans"), "zh-CN");
  assert.equal(resolveTelegramLocale("zh-TW"), "zh-CN");
  assert.equal(resolveTelegramLocale("de-AT"), TELEGRAM_DEFAULT_LOCALE);
  assert.equal(resolveTelegramLocale(undefined), TELEGRAM_DEFAULT_LOCALE);
  assert.equal(resolveTelegramLocale(""), TELEGRAM_DEFAULT_LOCALE);
  assert.equal(resolveTelegramLocale("   "), TELEGRAM_DEFAULT_LOCALE);
});

test("i18n recognizes only supported locale values", () => {
  assert.equal(isTelegramLocale("en"), true);
  assert.equal(isTelegramLocale("zh-CN"), true);
  assert.equal(isTelegramLocale("zh"), false);
  assert.equal(isTelegramLocale(undefined), false);
  assert.deepEqual([...TELEGRAM_SUPPORTED_LOCALES], ["en", "zh-CN"]);
});

test("i18n translates and falls back to English for missing keys", () => {
  assert.equal(t("en", "common.mainMenu"), "⬆️ Main menu");
  assert.equal(t("zh-CN", "common.mainMenu"), "⬆️ 主菜单");
  // A key without a zh-CN override falls back to English.
  assert.equal(t("zh-CN", "status.title"), "📊 状态");
  assert.equal(t("zh-CN", "common.close"), "✖️ 关闭");
  const translate = createTelegramTranslator("zh-CN");
  assert.equal(translate("settings.title"), "⚙️ 设置");
  assert.equal(formatTelegramToggleState("en", true), "on");
  assert.equal(formatTelegramToggleState("zh-CN", false), "关");
});

test("i18n interpolates placeholders without touching unknown ones", () => {
  assert.equal(
    interpolateTelegramMessage("Hello {name}, you have {count}", {
      name: "Ada",
      count: 3,
    }),
    "Hello Ada, you have 3",
  );
  assert.equal(interpolateTelegramMessage("{missing} stays"), "{missing} stays");
  assert.equal(interpolateTelegramMessage("plain"), "plain");
});

test("i18n extracts the sender language code from update carriers", () => {
  assert.equal(
    getTelegramUpdateLanguageCode({
      message: { from: { language_code: "zh-CN" } },
    }),
    "zh-CN",
  );
  assert.equal(
    getTelegramUpdateLanguageCode({
      callback_query: { from: { language_code: "en" } },
    }),
    "en",
  );
  assert.equal(getTelegramUpdateLanguageCode({ message: {} }), undefined);
  assert.equal(getTelegramUpdateLanguageCode(undefined), undefined);
  assert.equal(
    getTelegramUpdateLanguageCode({ message: { from: { language_code: "" } } }),
    undefined,
  );
});

test("i18n localizes the built-in command menu per language", () => {
  assert.deepEqual(
    TELEGRAM_BOT_COMMANDS.map((command) => command.command),
    getTelegramBuiltinBotCommands("en").map((command) => command.command),
  );
  const zh = getTelegramBuiltinBotCommands("zh-CN");
  assert.equal(zh[0]?.description, "🟢 打开菜单 / 配对连接");
  assert.equal(zh[3]?.description, "📚 列出或切换会话");
  assert.notDeepEqual(zh, TELEGRAM_BOT_COMMANDS);
});

test("UI helpers render locale-aware heroes, breadcrumbs, and toggles", () => {
  const hero = buildTelegramHeroHtml({
    title: "Pi Telegram",
    subtitle: "Pitch",
    tip: "Tip",
  });
  assert.match(hero, /^<b>Pi Telegram<\/b>/);
  assert.match(hero, /<blockquote>Pitch<\/blockquote>/);
  assert.match(hero, /<i>Tip<\/i>/);
  assert.equal(
    buildTelegramBreadcrumbHtml(["⚙️ Settings", "home", "settings"]),
    "<b>⚙️ Settings</b> · home › settings",
  );
  assert.equal(formatTelegramToggleButtonLabel("Draft", false), "⬜ Draft");
  assert.equal(formatTelegramToggleButtonLabel("Draft", true), "✅ Draft");
  assert.deepEqual(getTelegramStatusLabels("zh-CN"), {
    status: "状态",
    tokens: "Token",
    cache: "缓存",
    cost: "费用",
    context: "上下文",
  });
});

test("language settings offer every supported locale and mark the current one", () => {
  const markup = buildLanguageSettingsReplyMarkup("zh-CN");
  assert.deepEqual(
    markup.inline_keyboard.map((row) => row[0]?.text),
    ["⬆️ 返回", "en", "🟢 zh-CN"],
  );
  assert.match(buildLanguageSettingsText("en"), /<b>🌐 Language:<\/b>/);
  assert.match(buildLanguageSettingsText("zh-CN"), /<b>🌐 语言:<\/b>/);
});
