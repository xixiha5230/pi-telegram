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
  "settings.toggleOn": "On",
  "settings.toggleOff": "Off",
  "settings.reviewInactive": "🔎 Review inactive tabs",
  "settings.cleanInactive": "🧹 Clean inactive tabs",
  "settings.backToCleanup": "⬆️ Back to Thread cleanup",
  "settings.threadDisplay.intro": "Choose how this bot profile labels Telegram tabs and Pi terminal status. Each slot is unique across this bot profile.",
  "settings.threadDisplay.nameHint": "Set a manual name for the current Thread with /name <code>Name</code>.",
  "settings.threadDisplay.letters": "<code>-</code> <code>letters</code> (default): show the unique slot, such as <b><i>A</i></b> or <b><i>B</i></b>.",
  "settings.threadDisplay.names": "<code>-</code> <code>names</code>: show the generated dictionary name for the slot, such as <b><i>Anchor</i></b> or <b><i>Briar</i></b>.",
  "settings.threadDisplay.directoryTitle": "<code>-</code> <code>directory-title</code>: humanize the distinguishing directory path, such as <b><i>Api Tools</i></b> or <b><i>Frontend / Extensions A</i></b>.",
  "settings.threadDisplay.directorySnake": "<code>-</code> <code>directory-snake</code>: normalize the distinguishing directory path to lowercase, such as <b><i>api_tools</i></b> or <b><i>frontend_extensions_a</i></b>.",
  "settings.threadDisplay.state": "<code>-</code> <code>state</code>: the <code>directory-snake</code> label prefixed with the bound worker's live state, such as <b><i>🟢 api_tools</i></b> when ready or <b><i>⏳ api_tools</i></b> while it is working.",
  "settings.cleanup.intro": "Delete this Pi instance's Telegram tab when Pi quits normally.",
  "settings.cleanup.on": "<code>-</code> <code>on</code> (default): delete the bound thread and release Telegram authority on graceful quit.",
  "settings.cleanup.off": "<code>-</code> <code>off</code>: preserve the tab as a restart hint; manual <code>/telegram disconnect</code> still confirms and deletes it.",
  "settings.cleanup.reviewNote": "Review inactive tabs checks current owner and work evidence. Review never deletes tabs.",
  "settings.review.title": "🔎 Inactive tabs review",
  "settings.review.count": "{count} proven inactive tab(s).",
  "settings.review.noDelete": "No tabs were deleted.",
  "settings.review.requiresConfirm": "Deletion requires a separate confirmed Clean action.",
  "settings.draftPreviews.intro": "Show live answer drafts while the model is answering.",
  "settings.draftPreviews.on": "<code>-</code> <code>on</code> (default): stream safe Telegram Rich Draft frames before the final answer.",
  "settings.draftPreviews.off": "<code>-</code> <code>off</code>: show native active status, then send one final answer.",
  "settings.rendering.intro": "Choose how final assistant Markdown answers are delivered.",
  "settings.rendering.rich": "<code>-</code> <code>rich</code> (default): use Telegram Native Rich Markdown.",
  "settings.rendering.html": "<code>-</code> <code>html</code>: use the legacy Markdown-to-HTML renderer.",
  "settings.activity.intro": "Choose how much technical model activity Telegram shows.",
  "settings.activity.quiet": "<code>-</code> <code>quiet</code>: show no thinking or tool traffic.",
  "settings.activity.thinking": "<code>-</code> <code>thinking</code>: show persistent collapsed thinking.",
  "settings.activity.tools": "<code>-</code> <code>tools</code>: show persistent Rich tool details.",
  "settings.activity.verbose": "<code>-</code> <code>verbose</code> (default): show both thinking and tools.",
  "settings.voiceReply.intro": "Controls when pi-telegram converts assistant text replies into Telegram voice messages.",
  "settings.voiceReply.manual": "<code>-</code> <code>manual</code> (default): add no automatic voice context; explicit 'telegram_voice' actions still work.",
  "settings.voiceReply.mirror": "<code>-</code> <code>mirror</code>: voice input activates automatic voice delivery; text input follows 'manual' behavior.",
  "settings.voiceReply.always": "<code>-</code> <code>always</code>: activate automatic voice delivery for every reply.",
  "settings.timeInjection.intro": "Controls whether Telegram-originated prompts include a compact wall-clock [time] line.",
  "settings.timeInjection.hidden": "<code>-</code> <code>hidden</code>: no time line is added to prompt context.",
  "settings.timeInjection.always": "<code>-</code> <code>always</code>: add time to every Telegram turn.",
  "settings.timeInjection.interval": "<code>-</code> <code>interval</code> (default): add time at most once per chat interval (1 hour unless configured).",

  "model.title": "🤖 Choose a model",
  "model.pageTitle": "Choose a page",
  "model.detailTitle": "🤖 Model",
  "thinking.title": "🧠 Choose a thinking level",
  "queue.title": "🔢 Queue",
  "queue.empty": "Nothing is waiting in the queue.",
  "queue.listTitle": "⏳ Queue",
  "queue.emptyTitle": "⌛ Queue is empty",
  "queue.refresh": "🔄 Refresh",
  "queue.priority": "Priority",
  "queue.normal": "Normal",
  "queue.keep": "Keep",
  "queue.skip": "Skip",
  "queue.truncated": "… [truncated]",
  "queue.empty.0": "⌛ Queue is still empty",
  "queue.empty.1": "🫙 Still nothing in queue",
  "queue.empty.2": "🍃 Queue remains empty",
  "queue.empty.3": "🕳 Nothing queued yet",
  "queue.empty.4": "🦗 Queue crickets continue",
  "queue.empty.5": "🌙 Queue is peacefully idle",
  "queue.empty.6": "🧘 Nothing waiting. Very zen",
  "queue.empty.7": "🪐 Queue orbit is clear",
  "queue.empty.8": "🧺 Basket is empty",
  "queue.empty.9": "🔭 No prompts on the horizon",
  "queue.empty.10": "🫧 Queue bubbles: none",
  "queue.empty.11": "🛸 No queued signals detected",
  "status.title": "📊 Status",
  "daemon.title": "🛠️ Daemon control",
  "daemon.subtitle": "Pick an action below.",
  "daemon.workers": "👷 Workers",
  "daemon.newWorker": "📁 New worker…",
  "daemon.status": "ℹ️ Status",
  "daemon.threads": "🧹 Threads",
  "daemon.menu": "↩️ Menu",
  "daemon.close": "✖️ Close",
  "daemon.stop": "🛑 Stop",
  "daemon.restart": "♻️ Restart",
  "daemon.back": "↩️ Back",
  "daemon.workersBack": "↩️ Workers",
  "daemon.unknownWorker": "⚠️ **Unknown Pi worker.**",
  "daemon.managedUnavailable": "🚫 **Managed Pi workers are unavailable.**",
  "daemon.cleanup.title": "🧹 Inactive Threads",
  "daemon.cleanup.reviewInactive": "🔍 Review inactive",
  "daemon.cleanup.deleteReviewed": "🗑 Delete reviewed",
  "daemon.cleanup.deleteOnQuit": "Delete tab on quit",
  "daemon.cleanup.unattended": "Unattended cleanup",
  "daemon.cleanup.line1": "Deleting this instance's tab on graceful quit is {state}.",
  "daemon.cleanup.line2": "Deleting proven inactive tabs unattended is {state}; only tabs idle for over 24h qualify.",
  "daemon.cleanup.line3": "Review only proves which tabs are inactive; deleting needs an explicit tap or the unattended switch.",
  "daemon.notice.noInactive": "No proven inactive tabs.",
  "daemon.notice.reviewPrepared": "Review prepared {count} proven inactive tab(s). Nothing was deleted.",
  "daemon.notice.reviewAlert": "{count} proven inactive tab(s); nothing was deleted.",
  "daemon.notice.reviewFailed": "Could not safely review inactive tabs.",
  "daemon.notice.unattendedOn": "Provably inactive tabs now delete unattended.",
  "daemon.notice.unattendedOff": "Unattended deletion is off.",
  "daemon.notice.unattendedFailed": "Could not change the unattended cleanup setting.",
  "daemon.notice.deleted": "Deleted {deleted} tab(s); {blocked} stayed blocked.",
  "daemon.notice.deletedAlert": "Deleted {deleted}; blocked {blocked}.",
  "daemon.notice.deleteFailed": "Could not safely delete the reviewed tabs.",
  "daemon.notice.cleanupOn": "Tabs delete on graceful quit.",
  "daemon.notice.cleanupOff": "Tabs are preserved on quit.",
  "daemon.notice.cleanupFailed": "Could not change the cleanup setting.",
  "daemon.notice.attachUnavailable": "⚠️ **Thread attachment is unavailable in this topology.**",
  "daemon.notice.attachFailed": "⚠️ **Could not attach the Pi worker.**",
  "daemon.notice.attached": "✅ **Attached this thread to <code>{worker}</code>.**",
  "daemon.notice.noWorker": "ℹ️ **This thread had no Pi worker.**",
  "daemon.notice.detached": "✅ **Detached this thread.**",
  "daemon.stop.confirmTitle": "🛑 Stop {label}?",
  "daemon.stop.confirmBody": "Its Telegram Thread stays; the worker process ends.",
  "daemon.browser.title": "📂 Pick a project directory",
  "daemon.browser.empty": "_No subdirectories._",
  "daemon.browser.up": "⬆️ ..",
  "daemon.browser.startHere": "✅ Start a worker here",
  "daemon.browser.notDirectory": "⚠️ **Not an existing directory:**",
  "daemon.browser.cannotRead": "⚠️ **Cannot read directory:**",
  "daemon.browser.unknownAction": "⚠️ **Unknown action.**",
  "daemon.browser.expired": "⚠️ **This directory picker expired. Open it again.**",
  "status.row.status": "Status",
  "status.row.tokens": "Tokens",
  "status.row.cache": "Cache",
  "status.row.cost": "Cost",
  "status.row.context": "Context",
  "sessions.title": "🗂 Sessions",
  "sessions.projectsTitle": "Projects — tap to open",
  "sessions.projectTapToSwitch": "{path} — tap a session to switch",
  "sessions.backToProjects": "⬅️ Projects",
  "sessions.expired": "⌛ Session list expired.",
  "sessions.expiredSendAgain": "⌛ Session list expired. Send /sessions again.",
  "sessions.projectExpired": "⚠️ Project list expired. Send /sessions again.",
  "sessions.switchUnavailable": "🚫 Session switching is unavailable.",
  "sessions.switchingTo": "🔀 Switching to {label}…",
  "sessions.switchStartFailed": "⚠️ Could not start the session switch. Try again.",
  "sessions.switched": "🔀 Session switched.",
  "sessions.switchCancelled": "🚫 Session switch cancelled.",
  "sessions.switchFailed": "⚠️ Session switch failed.",
  "sessions.recentSessions": "Recent sessions (send /sessions <number> to switch)",
  "sessions.none": "No Pi sessions found.",
  "commands.sessionSwitched": "🔀 Session switched.",
  "commands.sessionSwitchCancelled": "🚫 Session switch cancelled.",
  "commands.sessionSwitchFailed": "⚠️ Session switch failed.",
  "commands.newSessionStarted": "🆕 New session started.",
  "commands.newSessionCancelled": "🚫 New session cancelled.",
  "commands.newSessionFailed": "⚠️ New session failed.",
  "commands.compactConfirm": "Compact session?",
  "sessions.listTitle": "Sessions in {cwd}",
  "sessions.empty": "(empty session)",
  "sessions.unknownDir": "(unknown directory)",
  "sessions.msgs": "msgs",
  "sessions.count": "sessions",
  "sessions.justNow": "just now",
  "sessions.minutesAgo": "{n}m ago",
  "sessions.hoursAgo": "{n}h ago",
  "sessions.daysAgo": "{n}d ago",
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
  "settings.toggleOn": "开",
  "settings.toggleOff": "关",
  "settings.reviewInactive": "🔎 检查非活跃标签",
  "settings.cleanInactive": "🧹 清理非活跃标签",
  "settings.backToCleanup": "⬆️ 返回会话清理",
  "settings.threadDisplay.intro": "选择此 bot 配置如何为 Telegram 标签和 Pi 终端状态命名。每个槽位在此 bot 配置内唯一。",
  "settings.threadDisplay.nameHint": "用 /name <code>Name</code> 为当前会话设置手动名称。",
  "settings.threadDisplay.letters": "<code>-</code> <code>letters</code>（默认）：显示唯一槽位，例如 <b><i>A</i></b> 或 <b><i>B</i></b>。",
  "settings.threadDisplay.names": "<code>-</code> <code>names</code>：显示槽位对应的字典名称，例如 <b><i>Anchor</i></b> 或 <b><i>Briar</i></b>。",
  "settings.threadDisplay.directoryTitle": "<code>-</code> <code>directory-title</code>：将区分的目录路径人性化，例如 <b><i>Api Tools</i></b> 或 <b><i>Frontend / Extensions A</i></b>。",
  "settings.threadDisplay.directorySnake": "<code>-</code> <code>directory-snake</code>：将区分的目录路径规范为小写，例如 <b><i>api_tools</i></b> 或 <b><i>frontend_extensions_a</i></b>。",
  "settings.threadDisplay.state": "<code>-</code> <code>state</code>：在 <code>directory-snake</code> 标签前加绑定 worker 的实时状态，就绪时为 <b><i>🟢 api_tools</i></b>，工作中为 <b><i>⏳ api_tools</i></b>。",
  "settings.cleanup.intro": "Pi 正常退出时删除此 Pi 实例的 Telegram 标签。",
  "settings.cleanup.on": "<code>-</code> <code>on</code>（默认）：正常退出时删除绑定的会话并释放 Telegram 权限。",
  "settings.cleanup.off": "<code>-</code> <code>off</code>：保留标签作为重启提示；手动 <code>/telegram disconnect</code> 仍会确认并删除。",
  "settings.cleanup.reviewNote": "检查非活跃标签会核对当前所有者与工作证据。检查绝不会删除标签。",
  "settings.review.title": "🔎 非活跃标签检查",
  "settings.review.count": "{count} 个已证实非活跃的标签。",
  "settings.review.noDelete": "没有删除任何标签。",
  "settings.review.requiresConfirm": "删除需要单独的确认清理操作。",
  "settings.draftPreviews.intro": "模型作答时显示实时草稿。",
  "settings.draftPreviews.on": "<code>-</code> <code>on</code>（默认）：在最终答复前流式发送安全的 Telegram Rich Draft 帧。",
  "settings.draftPreviews.off": "<code>-</code> <code>off</code>：显示原生活动状态，然后发送一次最终答复。",
  "settings.rendering.intro": "选择最终 assistant Markdown 答复的投递方式。",
  "settings.rendering.rich": "<code>-</code> <code>rich</code>（默认）：使用 Telegram 原生 Rich Markdown。",
  "settings.rendering.html": "<code>-</code> <code>html</code>：使用旧版 Markdown 转 HTML 渲染器。",
  "settings.activity.intro": "选择 Telegram 显示多少技术性模型活动。",
  "settings.activity.quiet": "<code>-</code> <code>quiet</code>：不显示思考或工具流量。",
  "settings.activity.thinking": "<code>-</code> <code>thinking</code>：显示持续折叠的思考。",
  "settings.activity.tools": "<code>-</code> <code>tools</code>：显示持续的 Rich 工具详情。",
  "settings.activity.verbose": "<code>-</code> <code>verbose</code>（默认）：同时显示思考与工具。",
  "settings.voiceReply.intro": "控制 pi-telegram 何时将 assistant 文本回复转换为 Telegram 语音消息。",
  "settings.voiceReply.manual": "<code>-</code> <code>manual</code>（默认）：不添加上下文；显式的 'telegram_voice' 操作仍然有效。",
  "settings.voiceReply.mirror": "<code>-</code> <code>mirror</code>：语音输入触发自动语音投递；文本输入遵循 'manual' 行为。",
  "settings.voiceReply.always": "<code>-</code> <code>always</code>：每条回复都触发自动语音投递。",
  "settings.timeInjection.intro": "控制来自 Telegram 的提示是否包含紧凑的墙钟 [time] 行。",
  "settings.timeInjection.hidden": "<code>-</code> <code>hidden</code>：不向提示上下文添加时间行。",
  "settings.timeInjection.always": "<code>-</code> <code>always</code>：每轮 Telegram 都添加时间。",
  "settings.timeInjection.interval": "<code>-</code> <code>interval</code>（默认）：每个聊天间隔最多添加一次（默认 1 小时）。",

  "model.title": "🤖 选择模型",
  "model.pageTitle": "选择页码",
  "model.detailTitle": "🤖 模型",
  "thinking.title": "🧠 选择思考等级",
  "queue.title": "🔢 队列",
  "queue.empty": "队列中没有等待的任务。",
  "queue.listTitle": "⏳ 队列",
  "queue.emptyTitle": "⌛ 队列为空",
  "queue.refresh": "🔄 刷新",
  "queue.priority": "优先",
  "queue.normal": "普通",
  "queue.keep": "保留",
  "queue.skip": "跳过",
  "queue.truncated": "… [已截断]",
  "queue.empty.0": "⌛ 队列仍然是空的",
  "queue.empty.1": "🫙 队列里还是没有东西",
  "queue.empty.2": "🍃 队列依旧为空",
  "queue.empty.3": "🕳 还没有排队任务",
  "queue.empty.4": "🦗 队列依然静悄悄",
  "queue.empty.5": "🌙 队列安静地闲置着",
  "queue.empty.6": "🧘 没有等待，很禅意",
  "queue.empty.7": "🪐 队列轨道清空",
  "queue.empty.8": "🧺 篮子空空如也",
  "queue.empty.9": "🔭 地平线上没有提示",
  "queue.empty.10": "🫧 队列泡泡：无",
  "queue.empty.11": "🛸 未检测到排队信号",
  "status.title": "📊 状态",
  "daemon.title": "🛠️ 守护进程控制",
  "daemon.subtitle": "请选择下面的操作。",
  "daemon.workers": "👷 工作进程",
  "daemon.newWorker": "📁 新建工作进程…",
  "daemon.status": "ℹ️ 状态",
  "daemon.threads": "🧹 会话",
  "daemon.menu": "↩️ 菜单",
  "daemon.close": "✖️ 关闭",
  "daemon.stop": "🛑 停止",
  "daemon.restart": "♻️ 重启",
  "daemon.back": "↩️ 返回",
  "daemon.workersBack": "↩️ 工作进程",
  "daemon.unknownWorker": "⚠️ **未知的 Pi 工作进程。**",
  "daemon.managedUnavailable": "🚫 **托管 Pi 工作进程不可用。**",
  "daemon.cleanup.title": "🧹 非活跃会话",
  "daemon.cleanup.reviewInactive": "🔍 检查非活跃",
  "daemon.cleanup.deleteReviewed": "🗑 删除已检查项",
  "daemon.cleanup.deleteOnQuit": "退出时删除标签",
  "daemon.cleanup.unattended": "无人值守清理",
  "daemon.cleanup.line1": "正常退出时删除此实例的标签：{state}。",
  "daemon.cleanup.line2": "无人值守删除已证实的非活跃标签：{state}；仅超过 24 小时未活动的标签符合条件。",
  "daemon.cleanup.line3": "检查只证明哪些标签非活跃；删除需要显式点按或打开无人值守开关。",
  "daemon.notice.noInactive": "没有已证实的非活跃标签。",
  "daemon.notice.reviewPrepared": "检查准备了 {count} 个已证实非活跃的标签。未删除任何内容。",
  "daemon.notice.reviewAlert": "{count} 个已证实非活跃的标签；未删除任何内容。",
  "daemon.notice.reviewFailed": "无法安全地检查非活跃标签。",
  "daemon.notice.unattendedOn": "已证实的非活跃标签现在会无人值守删除。",
  "daemon.notice.unattendedOff": "无人值守删除已关闭。",
  "daemon.notice.unattendedFailed": "无法修改无人值守清理设置。",
  "daemon.notice.deleted": "已删除 {deleted} 个标签；{blocked} 个仍被阻止。",
  "daemon.notice.deletedAlert": "已删除 {deleted}；阻止 {blocked}。",
  "daemon.notice.deleteFailed": "无法安全地删除已检查的标签。",
  "daemon.notice.cleanupOn": "正常退出时会删除标签。",
  "daemon.notice.cleanupOff": "退出时会保留标签。",
  "daemon.notice.cleanupFailed": "无法修改清理设置。",
  "daemon.notice.attachUnavailable": "⚠️ **当前拓扑不支持会话绑定。**",
  "daemon.notice.attachFailed": "⚠️ **无法绑定 Pi 工作进程。**",
  "daemon.notice.attached": "✅ **已将本会话绑定到 <code>{worker}</code>。**",
  "daemon.notice.noWorker": "ℹ️ **本会话没有 Pi 工作进程。**",
  "daemon.notice.detached": "✅ **已解除本会话的绑定。**",
  "daemon.stop.confirmTitle": "🛑 停止 {label}？",
  "daemon.stop.confirmBody": "其 Telegram 会话保留；工作进程结束。",
  "daemon.browser.title": "📂 选择项目目录",
  "daemon.browser.empty": "_没有子目录。_",
  "daemon.browser.up": "⬆️ ..",
  "daemon.browser.startHere": "✅ 在此启动工作进程",
  "daemon.browser.notDirectory": "⚠️ **目录不存在：**",
  "daemon.browser.cannotRead": "⚠️ **无法读取目录：**",
  "daemon.browser.unknownAction": "⚠️ **未知操作。**",
  "daemon.browser.expired": "⚠️ **目录选择器已过期，请重新打开。**",
  "status.row.status": "状态",
  "status.row.tokens": "Token",
  "status.row.cache": "缓存",
  "status.row.cost": "费用",
  "status.row.context": "上下文",
  "sessions.title": "🗂 会话",
  "sessions.projectsTitle": "项目 — 点按打开",
  "sessions.projectTapToSwitch": "{path} — 点按会话以切换",
  "sessions.backToProjects": "⬅️ 项目",
  "sessions.expired": "⌛ 会话列表已过期。",
  "sessions.expiredSendAgain": "⌛ 会话列表已过期。请重新发送 /sessions。",
  "sessions.projectExpired": "⚠️ 项目列表已过期。请重新发送 /sessions。",
  "sessions.switchUnavailable": "🚫 会话切换不可用。",
  "sessions.switchingTo": "🔀 正在切换到 {label}…",
  "sessions.switchStartFailed": "⚠️ 无法启动会话切换，请重试。",
  "sessions.switched": "🔀 会话已切换。",
  "sessions.switchCancelled": "🚫 会话切换已取消。",
  "sessions.switchFailed": "⚠️ 会话切换失败。",
  "sessions.recentSessions": "最近的会话（发送 /sessions <编号> 以切换）",
  "sessions.none": "未找到 Pi 会话。",
  "commands.sessionSwitched": "🔀 会话已切换。",
  "commands.sessionSwitchCancelled": "🚫 会话切换已取消。",
  "commands.sessionSwitchFailed": "⚠️ 会话切换失败。",
  "commands.newSessionStarted": "🆕 新会话已开始。",
  "commands.newSessionCancelled": "🚫 新会话已取消。",
  "commands.newSessionFailed": "⚠️ 新会话失败。",
  "commands.compactConfirm": "压缩会话？",
  "sessions.listTitle": "{cwd} 中的会话",
  "sessions.empty": "（空会话）",
  "sessions.unknownDir": "（未知目录）",
  "sessions.msgs": "条消息",
  "sessions.count": "个会话",
  "sessions.justNow": "刚刚",
  "sessions.minutesAgo": "{n} 分钟前",
  "sessions.hoursAgo": "{n} 小时前",
  "sessions.daysAgo": "{n} 天前",
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
