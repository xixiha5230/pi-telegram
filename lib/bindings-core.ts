/**
 * Telegram bridge core binding runtimes
 * Zones: telegram, orchestration
 * Owns the host-parameterized queue, activity, and agent-message binding runtimes
 * that both the Pi entry and the external daemon compose. It imports no Pi tool
 * registration and no schema library, so a daemon host loads a smaller graph than
 * the Pi entry even though both still depend on the Pi SDK.
 */

import * as Activity from "./activity.ts";
import * as ActivityVerbosity from "./activity-verbosity.ts";
import * as GenerativeApps from "./generative-apps.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as Queue from "./queue.ts";
import * as Routing from "./routing.ts";
import type * as OutboundAttachments from "./outbound-attachments.ts";
import type * as Runtime from "./runtime.ts";
import type { TelegramTarget } from "./target.ts";

export type TelegramRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

type TelegramAgentTargetResolver = NonNullable<
  OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["resolveAgentTarget"]
>;
type TelegramAgentMessageRouter = NonNullable<
  OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["routeAgentMessage"]
>;

export interface TelegramQueueBindingRuntime<TContext> {
  mutation: Queue.TelegramQueueMutationController<TContext>;
  dispatchNext: (ctx: TContext) => void;
  requestNextDispatchAnnouncement: () => void;
  watchdog: Queue.TelegramQueueDispatchWatchdogRuntime<TContext>;
}

export function createTelegramQueueBindingRuntime<TContext>(deps: {
  store: Queue.TelegramQueueStateStore<TContext>;
  queue: Pick<Runtime.TelegramBridgeRuntime["queue"], "allocateItemOrder">;
  lifecycle: Pick<
    Runtime.TelegramBridgeRuntime["lifecycle"],
    "isCompactionInProgress" | "hasDispatchPending"
  >;
  activeTurn: Pick<Queue.TelegramActiveTurnStore, "has">;
  admission: {
    getSettlement: () =>
      | {
          onItemsDiscarded: (
            items: readonly Queue.TelegramQueueItem<TContext>[],
            ctx: TContext,
          ) => void;
          isItemReady: (item: Queue.TelegramQueueItem<TContext>) => boolean;
          onPromptHandedOff?: (
            item: Queue.PendingTelegramTurn,
            ctx: TContext,
          ) => void;
          onControlSettled: (
            item: Queue.PendingTelegramControlItem<TContext>,
            ctx: TContext,
          ) => void;
        }
      | undefined;
    hasPendingQueueMutationForItem: (
      item: Queue.TelegramQueueItem<TContext>,
    ) => boolean;
  };
  transportStamp: Pick<Queue.TelegramTransportStampRuntime, "isActive">;
  deferredDispatch: Pick<
    Queue.TelegramDeferredQueueDispatchRuntime<TContext>,
    "isBound" | "getGeneration" | "isGenerationActive"
  >;
  promptDispatch: Runtime.TelegramPromptDispatchRuntime<TContext>;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  updateStatus: (ctx: TContext, error?: string) => void;
  sendTextReply: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendTextReply"];
  sendUserMessage: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendUserMessage"];
  recordRuntimeEvent?: TelegramRuntimeEventRecorder;
}): TelegramQueueBindingRuntime<TContext> {
  const settleDiscardedItems = (
    items: readonly Queue.TelegramQueueItem<TContext>[],
    ctx: TContext,
  ): boolean => {
    const durableItems = items.filter(
      (item) => (item.admissionReceipts?.length ?? 0) > 0,
    );
    if (durableItems.length === 0) return true;
    const settlement = deps.admission.getSettlement();
    if (!settlement) return false;
    settlement.onItemsDiscarded(durableItems, ctx);
    return durableItems.every((item) => !settlement.isItemReady(item));
  };
  const mutation = Queue.createTelegramQueueMutationController({
    ...deps.store,
    allocateLaneOrder: deps.queue.allocateItemOrder,
    onItemsDiscarded(items, ctx) {
      if (!settleDiscardedItems(items, ctx)) {
        throw new Error(
          "Telegram queue items could not be discarded durably.",
        );
      }
    },
    updateStatus: deps.updateStatus,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const dispatch = Queue.createTelegramQueueDispatchRuntime({
    ...deps.store,
    isCompactionInProgress: deps.lifecycle.isCompactionInProgress,
    hasActiveTurn: deps.activeTurn.has,
    hasDispatchPending: deps.lifecycle.hasDispatchPending,
    isIdle: deps.isIdle,
    hasPendingMessages: deps.hasPendingMessages,
    hasDispatchContext: deps.deferredDispatch.isBound,
    getDispatchGeneration: deps.deferredDispatch.getGeneration,
    isDispatchGenerationActive: deps.deferredDispatch.isGenerationActive,
    isQueueItemTransportActive(item) {
      return deps.transportStamp.isActive(item.transportStamp);
    },
    hasPendingInboundQueueMutationForItem(item) {
      return deps.admission.hasPendingQueueMutationForItem(item);
    },
    isQueueItemAdmissionReady(item) {
      return (
        deps.admission.getSettlement()?.isItemReady(item) ??
        (item.admissionReceipts?.length ?? 0) === 0
      );
    },
    commitPromptDispatch(item, ctx) {
      if ((item.admissionReceipts?.length ?? 0) === 0) return true;
      const settlement = deps.admission.getSettlement();
      if (!settlement?.onPromptHandedOff) return false;
      settlement.onPromptHandedOff(item, ctx);
      return !settlement.isItemReady(item);
    },
    onControlSettled(item, ctx) {
      deps.admission.getSettlement()?.onControlSettled(item, ctx);
    },
    onPromptSkipped(item, ctx) {
      return settleDiscardedItems([item], ctx);
    },
    updateStatus: deps.updateStatus,
    sendTextReply: deps.sendTextReply,
    recordRuntimeEvent: deps.recordRuntimeEvent,
    ...deps.promptDispatch,
    sendUserMessage: deps.sendUserMessage,
  });
  return {
    mutation,
    dispatchNext: dispatch.dispatchNext,
    requestNextDispatchAnnouncement: dispatch.requestNextDispatchAnnouncement,
    watchdog: Queue.createTelegramQueueDispatchWatchdogRuntime({
      hasQueuedItems: deps.store.hasQueuedItems,
      dispatchNextQueuedTelegramTurn: dispatch.dispatchNext,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
  };
}

export interface TelegramGenerativeAppLiveSurfaceBinding {
  get: () =>
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
    | undefined;
  set: (
    runtime: GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
      | undefined,
  ) => void;
  shutdown: () => void;
}

export function createTelegramGenerativeAppLiveSurfaceBinding():
TelegramGenerativeAppLiveSurfaceBinding {
  let current:
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
    | undefined;
  return {
    get() { return current; },
    set(runtime) {
      current?.shutdown();
      current = runtime;
    },
    shutdown() {
      current?.shutdown();
      current = undefined;
    },
  };
}

export function createTelegramGenerativeAppBoundButtonActionInvoker<
  TQuery extends {
    message?: { chat?: { id?: number }; message_id?: number; message_thread_id?: number };
  },
>(deps: {
  agentDir: string;
  assertExecutionCurrent: (query: TQuery) => void;
  getExecutionFence: (query: TQuery) => GenerativeApps.GenerativeAppExecutionFence | undefined;
  getActiveProfileName?: () => string | undefined;
  getLiveSurfaceRuntime?: () =>
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
    | undefined;
  planOutput: ReturnType<typeof OutboundHandlers.createTelegramOutboundReplyPlanner>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number,
    markdown: string,
    options?: { replyMarkup?: OutboundHandlers.TelegramOutboundButtonMarkup },
  ) => Promise<unknown>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
    mode: "markdown",
    replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup,
  ) => Promise<void>;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): (
  action: OutboundHandlers.TelegramOutboundButtonAction,
  query: TQuery,
) => Promise<false | "new" | "edit"> {
  return async (action, query) => {
    let boundAction: GenerativeApps.GenerativeAppBoundAction | undefined;
    let handedOff:
      | GenerativeApps.GenerativeAppLiveSurface<GenerativeApps.TelegramBindLiveHandle>
      | undefined;
    try {
      boundAction = GenerativeApps.parseGenerativeAppBoundAction(action.prompt);
      if (!boundAction) return false;
      deps.assertExecutionCurrent(query);
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        throw new Error("Generative App callback target is unavailable.");
      }
      const liveSurfaces = deps.getLiveSurfaceRuntime?.();
      handedOff = liveSurfaces?.take(GenerativeApps.getTelegramBindLiveSurfaceKey(
        boundAction.app,
        deps.getActiveProfileName?.() ?? "default",
        {
          chatId,
          ...(query.message?.message_thread_id !== undefined
            ? { threadId: query.message.message_thread_id }
            : {}),
        },
      ));
      const result = await GenerativeApps.invokeGenerativeApp({
        agentDir: deps.agentDir,
        ...(deps.getExecutionFence(query)
          ? { execution: deps.getExecutionFence(query) }
          : {}),
        ...(boundAction.argument !== undefined
          ? { argument: boundAction.argument }
          : {}),
        ...(action.binding?.app === boundAction.app
          ? {
              expectedGeneration: action.binding.generation,
              expectedRevision: action.binding.revision,
            }
          : {}),
        method: boundAction.method,
        app: boundAction.app,
      });
      deps.assertExecutionCurrent(query);
      const reply = deps.planOutput(result.output, {
        binding: {
          generation: result.generation,
          app: result.app,
          revision: result.revision,
        },
      });
      if (handedOff && liveSurfaces) {
        try {
          await liveSurfaces.resume(handedOff, result);
          deps.assertExecutionCurrent(query);
          return "edit";
        } catch (error) {
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-live-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
      }
      if (result.viewMode === "edit" && deps.editInteractiveMessage) {
        let editFailed = false;
        try {
          await deps.editInteractiveMessage(
            chatId,
            messageId,
            reply.markdown,
            "markdown",
            reply.replyMarkup ?? { inline_keyboard: [] },
          );
        } catch (error) {
          editFailed = true;
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
        deps.assertExecutionCurrent(query);
        if (!editFailed) return "edit";
      }
      deps.assertExecutionCurrent(query);
      await deps.sendMarkdownReply(chatId, messageId, reply.markdown, {
        replyMarkup: reply.replyMarkup,
      });
      deps.assertExecutionCurrent(query);
      return "new";
    } catch (error) {
      if (handedOff) deps.getLiveSurfaceRuntime?.()?.open(handedOff);
      deps.recordRuntimeEvent("generative-app", error, {
        phase: "bound-action",
        ...(boundAction
          ? { app: boundAction.app, method: boundAction.method }
          : {}),
      });
      throw error;
    }
  };
}

export interface TelegramAgentMessageToolRoutingRuntime {
  resolveAgentTarget: TelegramAgentTargetResolver;
  routeAgentMessage: TelegramAgentMessageRouter;
  canSendDirect: () => boolean;
}

export function createTelegramAgentMessageToolRoutingRuntime(deps: {
  ownsLeader: () => boolean;
  ownsDirectDelivery: () => boolean;
  isFollowerRegistered: () => boolean;
  getSourceTarget: () => TelegramTarget | undefined;
  getSourceThreadName: () => string | undefined;
  local: {
    resolveTarget: (
      selector: Parameters<TelegramAgentTargetResolver>[0],
      sourceTarget?: TelegramTarget,
    ) => Awaited<ReturnType<TelegramAgentTargetResolver>> | undefined;
    route: (input: {
      sourceTarget?: TelegramTarget;
      sourceThreadName?: string;
      message: Parameters<TelegramAgentMessageRouter>[0];
    }) => Promise<void>;
  };
  follower: {
    resolveTarget: TelegramAgentTargetResolver;
    routeMessage: TelegramAgentMessageRouter;
  };
}): TelegramAgentMessageToolRoutingRuntime {
  return {
    async resolveAgentTarget(selector) {
      if (!deps.ownsLeader()) return deps.follower.resolveTarget(selector);
      const target = deps.local.resolveTarget(selector, deps.getSourceTarget());
      if (!target) {
        throw new Error(
          "Telegram agent target is unavailable, ambiguous, or not live.",
        );
      }
      return target;
    },
    async routeAgentMessage(message) {
      if (!deps.ownsLeader()) return deps.follower.routeMessage(message);
      await deps.local.route({
        sourceTarget: deps.getSourceTarget(),
        sourceThreadName: deps.getSourceThreadName(),
        message,
      });
    },
    canSendDirect() {
      return deps.ownsDirectDelivery() || deps.isFollowerRegistered();
    },
  };
}

export interface TelegramAssistantOutputBindingRuntime<TTransportStamp> {
  runtime: Activity.TelegramAssistantOutputRuntime;
  observeEvent: (event: Activity.TelegramActivityEvent) => void;
  authority: Routing.TelegramAssistantOutputAuthorityRuntime<TTransportStamp>;
}

export function createTelegramAssistantOutputBindingRuntime<
  TTransportStamp,
>(deps: {
  authority: {
    getPreferredTarget: () =>
      | OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"]
      | undefined;
    getFallbackChatId: () => number | undefined;
    getTransportStamp: () => TTransportStamp;
    isTransportStampActive: (stamp: TTransportStamp) => boolean;
    ownsDirect: () => boolean;
    getDirectEpoch: () => number | string | undefined;
    isFollowerRegistered: () => boolean;
    getFollowerGeneration: () => string | undefined;
  };
  sender: Parameters<
    typeof OutboundHandlers.createTelegramAssistantOutputSender<TTransportStamp>
  >[0];
  waitForActivityIdle?: () => Promise<void>;
  prepareTelegramPreview?: () => Activity.TelegramAssistantOutputPreparation | undefined;
  enqueue?: Activity.TelegramActivityPublicationRuntime["enqueue"];
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): TelegramAssistantOutputBindingRuntime<TTransportStamp> {
  const authority = Routing.createTelegramAssistantOutputAuthorityRuntime(
    deps.authority,
  );
  const sendOutput =
    OutboundHandlers.createTelegramAssistantOutputSender<TTransportStamp>(
      deps.sender,
    );
  const runtime = Activity.createTelegramAssistantOutputRuntime({
    ...authority,
    enqueue: deps.enqueue,
    prepareSend: (event) => event.source === "telegram" ? deps.prepareTelegramPreview?.() : undefined,
    async send(event, authority, isAuthorityActive) {
      await deps.waitForActivityIdle?.();
      if (!isAuthorityActive()) return;
      await sendOutput(event, authority, isAuthorityActive);
    },
    recordFailure(event, error) {
      deps.recordRuntimeEvent("proactive-push", error, {
        activityId: event.activityId,
        sequence: event.sequence,
        placement: event.placement,
      });
    },
  });
  return {
    runtime,
    authority,
    observeEvent(event) {
      if (event.type === "assistant-segment") runtime.accept(event);
    },
  };
}

type TelegramAssistantOutputAuthority<TTransportStamp> = ReturnType<
  Routing.TelegramAssistantOutputAuthorityRuntime<TTransportStamp>["captureAuthority"]
>;

export interface TelegramBridgePublicationRuntime {
  enqueue: Activity.TelegramActivityPublicationRuntime["enqueue"];
  reserve: Activity.TelegramActivityPublicationRuntime["reserve"];
  capture: () => { target?: Queue.TelegramQueueTarget; isCurrent: () => boolean };
}

export interface TelegramActivityBindingRuntime {
  publicationRuntime: TelegramBridgePublicationRuntime;
  activityRuntime: Activity.TelegramActivityRuntime;
  activityVerbosityRuntime: ActivityVerbosity.TelegramActivityVerbosityRuntime;
  assistantOutputRuntime: Activity.TelegramAssistantOutputRuntime;
}

/** Compose public activity fanout, verbosity, and assistant output ordering. */
export function createTelegramActivityBindingRuntime<TTransportStamp>(deps: {
  generation: string;
  assistantOutput: Omit<
    Parameters<
      typeof createTelegramAssistantOutputBindingRuntime<TTransportStamp>
    >[0],
    "waitForActivityIdle" | "enqueue"
  >;
  activityVerbosity: Omit<
    Parameters<
      typeof ActivityVerbosity.createTelegramActivityVerbosityRuntime<
        TelegramAssistantOutputAuthority<TTransportStamp>
      >
    >[0],
    "captureAuthority" | "isAuthorityActive" | "recordFailure" | "enqueue"
  >;
}): TelegramActivityBindingRuntime {
  const publication = Activity.createTelegramActivityPublicationRuntime();
  const assistantOutputBinding =
    createTelegramAssistantOutputBindingRuntime({
      ...deps.assistantOutput,
      enqueue: publication.enqueue,
    });
  const activityVerbosityRuntime =
    ActivityVerbosity.createTelegramActivityVerbosityRuntime({
      ...deps.activityVerbosity,
      enqueue: publication.enqueue,
      captureAuthority: assistantOutputBinding.authority.captureAuthority,
      isAuthorityActive: assistantOutputBinding.authority.isAuthorityActive,
      recordFailure(operation, event, error) {
        deps.assistantOutput.recordRuntimeEvent("activity", error, {
          operation,
          eventType: event.type,
          activityId: event.activityId,
        });
      },
    });
  const activityRuntime = Activity.createTelegramActivityBridgeRuntime({
    generation: deps.generation,
    observeEvent(event) {
      assistantOutputBinding.observeEvent(event);
      activityVerbosityRuntime.accept(event);
    },
    recordFailure(handlerId, event, error) {
      deps.assistantOutput.recordRuntimeEvent("activity", error, {
        handlerId,
        eventType: event.type,
        activityId: event.activityId,
      });
    },
  });
  return {
    activityRuntime: {
      ...activityRuntime,
      onSessionStart() {
        publication.reset();
        activityRuntime.onSessionStart?.();
      },
      onSessionShutdown() {
        publication.reset();
        activityRuntime.onSessionShutdown();
      },
    },
    activityVerbosityRuntime,
    assistantOutputRuntime: assistantOutputBinding.runtime,
    publicationRuntime: {
      enqueue: publication.enqueue,
      reserve: publication.reserve,
      capture() {
        const authority = assistantOutputBinding.authority.captureAuthority();
        return {
          target: authority.target ? { ...authority.target } : undefined,
          isCurrent: () => assistantOutputBinding.authority.isAuthorityActive(authority),
        };
      },
    },
  };
}

