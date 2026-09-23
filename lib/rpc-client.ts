/**
 * Pi RPC channel client
 * Zones: daemon control plane, pi agent sdk boundary
 * Owns strict JSONL framing and request/response correlation for a managed
 * `pi --mode rpc` worker. Frames split only on LF (U+000A): a generic line
 * reader is not protocol-compliant because it also splits on U+2028/U+2029,
 * which are legal inside JSON strings.
 */

export interface TelegramRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: unknown;
}

export interface TelegramRpcFrameBatch {
  frames: string[];
  rest: string;
}

/** Split complete LF-delimited frames out of a streaming buffer. */
export function splitTelegramRpcFrames(buffer: string): TelegramRpcFrameBatch {
  const frames: string[] = [];
  let start = 0;
  for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n", start)) {
    let frame = buffer.slice(start, index);
    if (frame.endsWith("\r")) frame = frame.slice(0, -1);
    if (frame.length > 0) frames.push(frame);
    start = index + 1;
  }
  return { frames, rest: buffer.slice(start) };
}

export interface TelegramRpcClientPorts {
  /** Write one outbound JSON line; the client owns the trailing LF. */
  write: (line: string) => void;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  newRequestId?: () => string;
  onEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
  defaultTimeoutMs?: number;
}

export interface TelegramRpcClient {
  request: (
    command: { type: string; [key: string]: unknown },
    options?: { timeoutMs?: number },
  ) => Promise<TelegramRpcResponse>;
  /** Feed one stdout frame. Returns true when the frame resolved a request. */
  handleFrame: (frame: string) => boolean;
  pendingCount: () => number;
  close: (reason?: string) => void;
}

interface PendingRequest {
  resolve: (response: TelegramRpcResponse) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

let fallbackRequestCounter = 0;

export function createTelegramRpcClient(
  ports: TelegramRpcClientPorts,
): TelegramRpcClient {
  const pending = new Map<string, PendingRequest>();
  const setTimer =
    ports.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = ports.clearTimer ?? ((handle) => clearTimeout(handle as never));
  const newRequestId =
    ports.newRequestId ??
    (() => `rpc-${(fallbackRequestCounter += 1)}`);
  const defaultTimeoutMs = ports.defaultTimeoutMs ?? 30_000;
  let closed = false;

  const settle = (
    id: string,
    frame: string,
  ): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimer(entry.timer);
    let parsed: TelegramRpcResponse;
    try {
      parsed = JSON.parse(frame) as TelegramRpcResponse;
    } catch (error) {
      entry.reject(
        error instanceof Error ? error : new Error("Malformed RPC response frame."),
      );
      return true;
    }
    entry.resolve(parsed);
    return true;
  };

  return {
    request(command, options) {
      if (closed) {
        return Promise.reject(new Error("Telegram RPC client is closed."));
      }
      const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
      const id =
        typeof command.id === "string" && command.id.length > 0
          ? command.id
          : newRequestId();
      return new Promise<TelegramRpcResponse>((resolve, reject) => {
        const timer = setTimer(() => {
          pending.delete(id);
          reject(new Error(`Telegram RPC request timed out: ${command.type}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          ports.write(`${JSON.stringify({ ...command, id })}\n`);
        } catch (error) {
          pending.delete(id);
          clearTimer(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    handleFrame(frame) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame);
      } catch (error) {
        ports.onError?.(
          error instanceof Error ? error : new Error("Malformed RPC frame."),
        );
        return false;
      }
      const record = parsed as { type?: unknown; id?: unknown };
      if (
        record.type === "response" &&
        typeof record.id === "string" &&
        settle(record.id, frame)
      ) {
        return true;
      }
      ports.onEvent?.(parsed);
      return false;
    },
    pendingCount: () => pending.size,
    close(reason = "Telegram RPC client was closed.") {
      if (closed) return;
      closed = true;
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimer(entry.timer);
        entry.reject(new Error(reason));
      }
    },
  };
}
