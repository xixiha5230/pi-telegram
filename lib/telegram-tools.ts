/**
 * Telegram Pi tool registration
 * Zones: telegram, pi agent tool registration
 * Owns registration of every Telegram tool surface (channel posts, outbound
 * messages and attachments, Generative App bind) and their JSON schemas. It is
 * the only Telegram module that depends on a schema builder, so a non-Pi host
 * such as the external daemon never loads it.
 */

import { createHash } from "node:crypto";

import { Type } from "@sinclair/typebox";

import {
  DEFAULT_MAX_RECORDS,
  isTelegramChannelPostValidationError,
  MAX_ID_LENGTH,
  MAX_MARKDOWN_LENGTH,
  type TelegramChannelPostAddress,
  type TelegramChannelPostJournalStore,
  type TelegramChannelPostRecord,
} from "./channel-posts.ts";
import {
  bindGenerativeApp,
  createGenerativeAppLiveSurfaceRuntime,
  formatDisplayedGenerativeAppToolOutput,
  formatGenerativeAppToolError,
  formatGenerativeAppToolOutput,
  getTelegramBindLiveSurfaceKey,
  type GenerativeAppInvocationResult,
  type GenerativeAppLiveSurfaceFrame,
  type TelegramBindDeliveryHandle,
  type TelegramBindLiveHandle,
  type TelegramBindToolRegistrationDeps,
} from "./generative-apps.ts";
import {
  MAX_ATTACHMENTS_PER_TURN,
  queueTelegramOutboundAttachments,
  sendTelegramOutboundMessage,
  TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES,
  type TelegramOutboundAttachmentToolRegistrationDeps,
  type TelegramOutboundMessageToolRegistrationDeps,
} from "./outbound-attachments.ts";
import type { ExtensionAPI } from "./pi.ts";
import {
  TELEGRAM_ATTACH_PROMPT_GUIDELINES,
  TELEGRAM_ATTACH_PROMPT_SNIPPET,
  TELEGRAM_MESSAGE_PROMPT_GUIDELINES,
  TELEGRAM_MESSAGE_PROMPT_SNIPPET,
} from "./prompts.ts";


function formatTelegramChannelPostToolOutput(value: unknown): string {
  // Pi's compact tool rows need one leading newline to separate call and result.
  return `\n${JSON.stringify(value, null, 2)}`;
}

function formatTelegramChannelPostToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`\n${message.replace(/^\n+/u, "") || "Telegram channel post operation failed."}`);
}

export function registerTelegramChannelPostMutationTool(
  pi: ExtensionAPI,
  deps: { mutate(input: { action: "edit" | "delete"; operationId: string;
    mutationId: string; markdown?: string }): Promise<TelegramChannelPostRecord> },
): void {
  pi.registerTool({
    name: "telegram_channel_post",
    label: "Edit or Delete Telegram Channel Post",
    description: "Edit or delete one exact published post retained by telegram_channel_posts; a media post edit replaces its caption. Unknown outcomes are never replayed.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("edit"), Type.Literal("delete")]),
      operation_id: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH }),
      markdown: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MARKDOWN_LENGTH })),
    }),
    async execute(toolCallId, params) {
      try {
        const record = await deps.mutate({ action: params.action, operationId: params.operation_id,
          mutationId: toolCallId, ...(params.markdown === undefined ? {} : { markdown: params.markdown }) });
        return { content: [{ type: "text" as const, text: formatTelegramChannelPostToolOutput(record) }],
          details: { record } };
      } catch (error) {
        if (isTelegramChannelPostValidationError(error)) {
          throw formatTelegramChannelPostToolError(error);
        }
        throw new Error("\nTelegram channel post mutation failed; inspect the retained local record before retrying.");
      }
    },
  });
}

export function registerTelegramChannelPostListTool(
  pi: ExtensionAPI,
  deps: { list: TelegramChannelPostJournalStore["list"] },
): void {
  pi.registerTool({
    name: "telegram_channel_posts",
    label: "Telegram Channel Posts",
    description: "List bounded local records for channel posts authored by this agent path. This does not read Telegram channel history.",
    parameters: Type.Object({
      chat_id: Type.Optional(Type.Union([
        Type.Number(), Type.String({ pattern: "^@[A-Za-z0-9_]{5,32}$" }),
      ])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_RECORDS })),
    }),
    async execute(_toolCallId, params) {
      try {
        const records = deps.list({
          channel: params.chat_id as TelegramChannelPostAddress | undefined,
          limit: params.limit,
        });
        return { content: [{ type: "text" as const, text: formatTelegramChannelPostToolOutput(records) }],
          details: { records } };
      } catch {
        throw new Error("\nTelegram channel post listing failed without exposing retained content or storage details.");
      }
    },
  });
}


function formatTelegramOutboundToolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`\n${message.replace(/^\n+/u, "") || "Telegram outbound operation failed."}`);
}

export function registerTelegramOutboundAttachmentTool(
  pi: ExtensionAPI,
  deps: TelegramOutboundAttachmentToolRegistrationDeps,
): void {
  const maxAttachmentsPerTurn =
    deps.maxAttachmentsPerTurn ?? MAX_ATTACHMENTS_PER_TURN;
  const maxAttachmentSizeBytes =
    deps.maxAttachmentSizeBytes ?? TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES;
  pi.registerTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description:
      "Queue one or more local files for the active Telegram reply, or send them immediately to Telegram when no Telegram turn is active.",
    promptSnippet: TELEGRAM_ATTACH_PROMPT_SNIPPET,
    promptGuidelines: [...TELEGRAM_ATTACH_PROMPT_GUIDELINES],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Local file path to attach" }),
        { minItems: 1, maxItems: maxAttachmentsPerTurn },
      ),
      chat_id: Type.Optional(
        Type.Number({
          description:
            "Optional Telegram chat id for immediate delivery when no Telegram turn is active",
        }),
      ),
      thread_id: Type.Optional(
        Type.Number({
          description:
            "Optional Telegram topic thread id for immediate delivery with chat_id",
        }),
      ),
      caption: Type.Optional(
        Type.String({
          description:
            "Optional caption for immediate delivery; ignored when queued for an active turn",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        return await queueTelegramOutboundAttachments({
          activeTurn: deps.getActiveTurn(),
          paths: params.paths,
          chatId: params.chat_id,
          threadId: params.thread_id,
          caption: params.caption,
          maxAttachmentsPerTurn,
          maxAttachmentSizeBytes,
          sendMultipart: deps.sendMultipart,
          getDefaultChatId: deps.getDefaultChatId,
          getDefaultTarget: deps.getDefaultTarget,
          canSendDirect: deps.canSendDirect,
          statPath: deps.statPath,
        });
      } catch (error) {
        deps.recordRuntimeEvent?.("attachment", error, {
          phase: "queue",
          count: params.paths.length,
        });
        throw formatTelegramOutboundToolError(error);
      }
    },
  });
}

export function registerTelegramOutboundMessageTool(
  pi: ExtensionAPI,
  deps: TelegramOutboundMessageToolRegistrationDeps,
): void {
  pi.registerTool({
    name: "telegram_message",
    label: "Telegram Message",
    description:
      "Send Markdown text directly to the paired/default Telegram chat, an exact channel chat_id, or an explicit live target. Channel delivery supports one optional local photo or video upload with the text as its caption. Channel posting requires Telegram-granted bot permission. Hidden telegram_button comments become inline prompt buttons.",
    promptSnippet: TELEGRAM_MESSAGE_PROMPT_SNIPPET,
    promptGuidelines: [...TELEGRAM_MESSAGE_PROMPT_GUIDELINES],
    parameters: Type.Object({
      text: Type.String({ description: "Message text to send" }),
      media: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Local single-file channel upload: .jpg/.jpeg/.png/.webp photo or .mp4 video; the text becomes its caption (max 1024 characters). Albums and other media types are rejected.",
        }),
      ),
      chat_id: Type.Optional(
        Type.Union([
          Type.Number(),
          Type.String({ pattern: "^@[A-Za-z0-9_]{5,32}$" }),
        ], { description: "Optional exact Telegram chat id or public channel @username" }),
      ),
      thread_id: Type.Optional(
        Type.Number({
          description: "Optional Telegram topic thread id with chat_id",
        }),
      ),
      channel: Type.Optional(Type.Boolean({
        description: "Set true only when a numeric chat_id is explicitly intended as a channel",
      })),
      thread: Type.Optional(
        Type.Union([Type.String(), Type.Number()], {
          description:
            "Optional live Pi thread name or numeric id for visible delivery plus a target-agent turn",
        }),
      ),
    }),
    async execute(toolCallId, params) {
      try {
        return await sendTelegramOutboundMessage({
          text: params.text,
          media: params.media,
          operationId: toolCallId,
          channel: params.channel,
          chatId: params.chat_id,
          threadId: params.thread_id,
          agentThread: params.thread,
          getDefaultChatId: deps.getDefaultChatId,
          getDefaultTarget: deps.getDefaultTarget,
          getActiveTurn: deps.getActiveTurn,
          resolveAgentTarget: deps.resolveAgentTarget,
          routeAgentMessage: deps.routeAgentMessage,
          canSendDirect: deps.canSendDirect,
          planMessage: deps.planMessage,
          sendMarkdownMessage: deps.sendMarkdownMessage,
          sendChannelMarkdownMessage: deps.sendChannelMarkdownMessage,
          sendChannelMediaMessage: deps.sendChannelMediaMessage,
        });
      } catch (error) {
        const isChannelTarget = typeof params.chat_id === "string" || params.channel === true;
        const reportableError = isChannelTarget &&
            !isTelegramChannelPostValidationError(error)
          ? new Error("Telegram channel publication failed; inspect the retained local record before retrying.")
          : error;
        deps.recordRuntimeEvent?.("message", reportableError, { phase: "direct" });
        throw formatTelegramOutboundToolError(reportableError);
      }
    },
  });
}

// Provider tool APIs reject recursive $ref schemas (OpenAI) and raw TypeBox
// optional markers on non-builder objects (Gemini), while llama-server rejects
// unconstrained subschemas; one bounded builder-made JSON-value union satisfies all.
const TELEGRAM_BIND_JSON_ARGUMENT_MAX_DEPTH = 4;

function createTelegramBindJsonArgumentSchema(
  depth: number,
): ReturnType<typeof Type.Union> {
  const scalars = [Type.Null(), Type.Boolean(), Type.Number(), Type.String()];
  if (depth <= 0) return Type.Union(scalars);
  const nested = createTelegramBindJsonArgumentSchema(depth - 1);
  return Type.Union([
    ...scalars,
    Type.Array(nested),
    Type.Object({}, { additionalProperties: nested }),
  ]);
}

export function registerTelegramBindTool(
  pi: ExtensionAPI,
  deps: TelegramBindToolRegistrationDeps,
): void {
  const planFrame = (
    result: GenerativeAppInvocationResult,
    handle: TelegramBindLiveHandle,
  ): GenerativeAppLiveSurfaceFrame<TelegramBindLiveHandle> => {
    const planned = deps.planOutput!(result.output, {
      binding: {
        generation: result.generation,
        app: result.app,
        revision: result.revision,
      },
    });
    const view = {
      text: planned.markdown,
      parseMode: "markdown" as const,
      ...(planned.replyMarkup !== undefined ? { replyMarkup: planned.replyMarkup } : {}),
    };
    return {
      digest: createHash("sha256").update(JSON.stringify(view)).digest("hex"),
      handle: { delivery: handle.delivery, view },
    };
  };
  const liveSurfaces = deps.planOutput && deps.editView && deps.isDeliveryHandleCurrent
    ? createGenerativeAppLiveSurfaceRuntime<TelegramBindLiveHandle>({
        agentDir: deps.agentDir,
        isCurrent: (surface) => deps.isDeliveryHandleCurrent!(surface.handle.delivery),
        plan: planFrame,
        async edit(frame) {
          const view = frame.handle.view;
          if (!view) throw new Error("Generative App live frame is missing its planned view.");
          const edited = await deps.editView!(frame.handle.delivery, view);
          if (!edited.ok) throw Object.assign(new Error(edited.message), {
            deliveryFailureReason: edited.reason,
            ...(edited.retryAfterMs === undefined ? {} : { retryAfterMs: edited.retryAfterMs }),
          });
          return { delivery: edited.value, view };
        },
        classifyEditError(error) {
          const failure = error as {
            deliveryFailureReason?: string;
            retryAfterMs?: number;
          };
          if (failure.deliveryFailureReason === "rate-limited") {
            return { kind: "retry", retryAfterMs: failure.retryAfterMs };
          }
          if (failure.deliveryFailureReason === "transport-retryable") {
            return { kind: "retry" };
          }
          if (failure.deliveryFailureReason === "message-unavailable") {
            return { kind: "unavailable" };
          }
          return {
            kind: failure.deliveryFailureReason === "commit-unknown" ? "unknown" : "terminal",
          };
        },
        recordRuntimeEvent: deps.recordRuntimeEvent,
        ...(deps.liveSurfaceSetTimer ? { setTimer: deps.liveSurfaceSetTimer } : {}),
        ...(deps.liveSurfaceClearTimer ? { clearTimer: deps.liveSurfaceClearTimer } : {}),
      })
    : undefined;
  deps.setLiveSurfaceRuntime?.(liveSurfaces);
  const surfaceKey = (app: string, handle: TelegramBindDeliveryHandle): string =>
    getTelegramBindLiveSurfaceKey(
      app,
      deps.getActiveProfileName?.() ?? "default",
      handle.target,
    );
  pi.registerTool({
    name: "telegram_bind",
    label: "Telegram Bind",
    description:
      "Install, explicitly replace, or invoke one named method on a managed Generative App; successful output displays directly in the active Telegram turn unless display is false.",
    parameters: Type.Object({
      app: Type.String(),
      script: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      replace: Type.Optional(Type.Boolean()),
      display: Type.Optional(Type.Boolean()),
      argument: Type.Optional(
        createTelegramBindJsonArgumentSchema(TELEGRAM_BIND_JSON_ARGUMENT_MAX_DEPTH),
      ),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      try {
        const result = await bindGenerativeApp({
          agentDir: deps.agentDir,
          ...(params.argument !== undefined ? { argument: params.argument } : {}),
          ...("method" in params && typeof params.method === "string"
            ? { method: params.method }
            : {}),
          app: params.app,
          ...("replace" in params && typeof params.replace === "boolean"
            ? { replace: params.replace }
            : {}),
          ...("script" in params && typeof params.script === "string"
            ? { script: params.script }
            : {}),
          methodTimeoutMs: deps.methodTimeoutMs,
        });
        const activeTurn = params.display === false
          ? undefined
          : deps.getActiveTurn?.();
        if (activeTurn && deps.planOutput && (deps.sendView || deps.sendMarkdownReply)) {
          try {
            const planned = deps.planOutput(result.output, {
              binding: {
                generation: result.generation,
                app: result.app,
                revision: result.revision,
              },
            });
            let messageId: number | undefined;
            if (deps.sendView) {
              const delivered = await deps.sendView(
                {
                  text: planned.markdown,
                  parseMode: "markdown",
                  ...(planned.replyMarkup !== undefined
                    ? { replyMarkup: planned.replyMarkup }
                    : {}),
                },
                {
                  scope: { kind: "active-turn" },
                  replyToMessageId: activeTurn.replyToMessageId,
                },
              );
              if (!delivered.ok) throw new Error(delivered.message);
              messageId = delivered.value.messageIds[0];
              if (liveSurfaces) {
                const key = surfaceKey(result.app, delivered.value);
                if (result.refreshAfterMs === undefined) {
                  liveSurfaces.cancel(key);
                } else {
                  const handle = { delivery: delivered.value };
                  const frame = planFrame(result, handle);
                  liveSurfaces.open({
                    app: result.app,
                    appGeneration: result.generation,
                    appRevision: result.revision,
                    handle,
                    initialDigest: frame.digest,
                    key,
                    refreshAfterMs: result.refreshAfterMs,
                  });
                }
              }
            } else {
              messageId = await deps.sendMarkdownReply!(
                activeTurn.chatId,
                activeTurn.replyToMessageId,
                planned.markdown,
                {
                  ...(planned.replyMarkup !== undefined
                    ? { replyMarkup: planned.replyMarkup }
                    : {}),
                  ...(activeTurn.target ? { target: activeTurn.target } : {}),
                },
              );
            }
            return {
              content: [{ type: "text", text: formatDisplayedGenerativeAppToolOutput() }],
              details: { ...result, displayed: true, messageId },
            };
          } catch (error) {
            deps.recordRuntimeEvent?.("generative-app", error, {
              phase: "bind-display",
              app: result.app,
              method: result.method,
            });
            return {
              content: [{ type: "text", text: formatGenerativeAppToolOutput(result.output) }],
              details: { ...result, displayed: false, displayFailed: true },
            };
          }
        }
        return {
          content: [{ type: "text", text: formatGenerativeAppToolOutput(result.output) }],
          details: { ...result, displayed: false },
        };
      } catch (error) {
        deps.recordRuntimeEvent?.("generative-app", error, {
          phase: "bind",
          app: params.app,
        });
        throw formatGenerativeAppToolError(error);
      }
    },
  });
}
