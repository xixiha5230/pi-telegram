/**
 * Managed Pi worker RPC host
 * Zones: daemon control plane, pi agent sdk boundary
 * Adapts a daemon-held `pi --mode rpc` channel into the surface the control plane
 * needs: typed state reads, prompt/steer/abort dispatch, and a live state projection
 * reduced from the worker's own event stream. The worker never runs the Telegram
 * bridge and never talks to Telegram; the daemon owns both directions.
 */

import type { TelegramRpcResponse } from "./rpc-client.ts";

/** Live projection of one managed worker's Pi session, fed by its RPC events. */
export interface TelegramRpcWorkerState {
  isStreaming: boolean;
  isCompacting: boolean;
  steering: readonly string[];
  followUp: readonly string[];
  model?: string;
  thinkingLevel?: string;
  sessionId?: string;
  sessionName?: string;
  updatedAtMs: number;
}

export function createTelegramRpcWorkerState(
  nowMs: number = Date.now(),
): TelegramRpcWorkerState {
  return {
    isStreaming: false,
    isCompacting: false,
    steering: [],
    followUp: [],
    updatedAtMs: nowMs,
  };
}

/** Busy means the worker is running model work the operator should see as active. */
export function isTelegramRpcWorkerBusy(state: TelegramRpcWorkerState): boolean {
  return state.isStreaming || state.isCompacting;
}

export function countTelegramRpcWorkerPending(state: TelegramRpcWorkerState): number {
  return state.steering.length + state.followUp.length;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readTextList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

/** Project a `get_state` response payload onto the live state. */
export function parseTelegramRpcWorkerState(
  data: unknown,
  nowMs: number,
): TelegramRpcWorkerState {
  const base = createTelegramRpcWorkerState(nowMs);
  if (!data || typeof data !== "object") return base;
  const record = data as Record<string, unknown>;
  const model =
    record.model && typeof record.model === "object"
      ? (record.model as { id?: unknown; provider?: unknown })
      : undefined;
  const modelId = readText(model?.id);
  const provider = readText(model?.provider);
  return {
    ...base,
    isStreaming: record.isStreaming === true,
    isCompacting: record.isCompacting === true,
    ...(modelId ? { model: provider ? `${provider}/${modelId}` : modelId } : {}),
    ...(readText(record.thinkingLevel)
      ? { thinkingLevel: readText(record.thinkingLevel)! }
      : {}),
    ...(readText(record.sessionId) ? { sessionId: readText(record.sessionId)! } : {}),
    ...(readText(record.sessionName)
      ? { sessionName: readText(record.sessionName)! }
      : {}),
  };
}

/**
 * Reduce one worker event onto the live state.
 *
 * Only transition events mutate the projection: token deltas and tool output are
 * renderer concerns and must never drive surfaces such as Thread titles.
 */
export function reduceTelegramRpcWorkerState(
  state: TelegramRpcWorkerState,
  event: unknown,
  nowMs: number,
): TelegramRpcWorkerState {
  if (!event || typeof event !== "object") return state;
  const record = event as Record<string, unknown>;
  switch (record.type) {
    case "agent_start":
      return state.isStreaming ? state : { ...state, isStreaming: true, updatedAtMs: nowMs };
    case "agent_end":
    case "agent_settled":
      return !state.isStreaming && !state.isCompacting
        ? state
        : { ...state, isStreaming: false, isCompacting: false, updatedAtMs: nowMs };
    case "compaction_start":
      return state.isCompacting
        ? state
        : { ...state, isCompacting: true, updatedAtMs: nowMs };
    case "compaction_end":
      return state.isCompacting
        ? { ...state, isCompacting: false, updatedAtMs: nowMs }
        : state;
    case "queue_update": {
      const steering = readTextList(record.steering);
      const followUp = readTextList(record.followUp);
      if (!steering && !followUp) return state;
      return {
        ...state,
        ...(steering ? { steering } : {}),
        ...(followUp ? { followUp } : {}),
        updatedAtMs: nowMs,
      };
    }
    default:
      return state;
  }
}

/** True when two projections would render identically. */
export function isSameTelegramRpcWorkerState(
  left: TelegramRpcWorkerState,
  right: TelegramRpcWorkerState,
): boolean {
  return (
    left.isStreaming === right.isStreaming &&
    left.isCompacting === right.isCompacting &&
    countTelegramRpcWorkerPending(left) === countTelegramRpcWorkerPending(right) &&
    left.model === right.model &&
    left.thinkingLevel === right.thinkingLevel &&
    left.sessionId === right.sessionId &&
    left.sessionName === right.sessionName
  );
}

export type TelegramRpcWorkerHostRequest = (
  command: { type: string; [key: string]: unknown },
  options?: { timeoutMs?: number },
) => Promise<TelegramRpcResponse>;

export interface TelegramRpcWorkerHostDeps {
  request: TelegramRpcWorkerHostRequest;
  now?: () => number;
}

export interface TelegramRpcWorkerHost {
  state: () => TelegramRpcWorkerState;
  /** Feed one streamed worker event (a frame the RPC client did not resolve). */
  ingest: (event: unknown) => void;
  /** Subscribe to every raw worker event; returns a disposer. */
  onEvent: (listener: (event: unknown) => void) => () => void;
  /** Subscribe to state transitions; returns a disposer. */
  onStateChange: (
    listener: (state: TelegramRpcWorkerState) => void,
  ) => () => void;
  /** Re-read `get_state`; resolves the resulting projection. */
  refreshState: () => Promise<TelegramRpcWorkerState>;
  prompt: (
    message: string,
    options?: {
      images?: readonly unknown[];
      streamingBehavior?: "steer" | "followUp";
    },
  ) => Promise<boolean>;
  steer: (message: string) => Promise<boolean>;
  abort: () => Promise<boolean>;
  setModel: (provider: string, modelId: string) => Promise<boolean>;
  setThinkingLevel: (level: string) => Promise<boolean>;
}

export function createTelegramRpcWorkerHost(
  deps: TelegramRpcWorkerHostDeps,
): TelegramRpcWorkerHost {
  const now = deps.now ?? Date.now;
  let current = createTelegramRpcWorkerState(now());
  const listeners = new Set<(state: TelegramRpcWorkerState) => void>();
  const eventListeners = new Set<(event: unknown) => void>();

  const publish = (next: TelegramRpcWorkerState): void => {
    // Only real transitions notify: title writers must never re-write on an
    // unchanged refresh, and Telegram limits topic-title edits.
    if (next === current || isSameTelegramRpcWorkerState(next, current)) return;
    current = next;
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        // A failing listener must never break the worker channel.
      }
    }
  };

  const settle = async (command: {
    type: string;
    [key: string]: unknown;
  }): Promise<boolean> => {
    try {
      const response = await deps.request(command);
      return response.success === true;
    } catch {
      return false;
    }
  };

  return {
    state: () => current,
    ingest(event) {
      for (const listener of eventListeners) {
        try {
          listener(event);
        } catch {
          // A failing renderer must never break the worker channel.
        }
      }
      publish(reduceTelegramRpcWorkerState(current, event, now()));
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refreshState() {
      try {
        const response = await deps.request({ type: "get_state" });
        if (response.success === true && response.data !== undefined) {
          publish(parseTelegramRpcWorkerState(response.data, now()));
        }
      } catch {
        // A state read failure leaves the last known projection in place.
      }
      return current;
    },
    prompt: (message, options) =>
      settle({
        type: "prompt",
        message,
        ...(options?.images?.length ? { images: options.images } : {}),
        ...(options?.streamingBehavior
          ? { streamingBehavior: options.streamingBehavior }
          : {}),
      }),
    steer: (message) => settle({ type: "steer", message }),
    abort: () => settle({ type: "abort" }),
    setModel: (provider, modelId) =>
      settle({ type: "set_model", provider, modelId }),
    setThinkingLevel: (level) => settle({ type: "set_thinking_level", level }),
  };
}
