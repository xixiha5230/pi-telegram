/**
 * Daemon control-plane persistence
 * Zones: daemon control plane, persistence
 * Owns the atomic JSON snapshot that lets a restarted daemon restore worker hints
 * and route bindings. It stores routing and identity hints only: never transport
 * secrets, bot tokens, or Pi session content.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const TELEGRAM_DAEMON_STATE_VERSION = 1;

export interface TelegramDaemonStateSnapshot {
  version: number;
  workers: readonly unknown[];
  routes: readonly unknown[];
  /** Operator `/attach` bindings: the thread a worker was re-homed from. */
  attachments?: readonly unknown[];
}

export interface TelegramDaemonStorePorts {
  read: () => string | undefined;
  write: (payload: string) => void;
}

export interface TelegramDaemonStore {
  load: () =>
    | {
        workers: readonly unknown[];
        routes: readonly unknown[];
        attachments: readonly unknown[];
      }
    | undefined;
  save: (state: {
    workers: readonly unknown[];
    routes: readonly unknown[];
    attachments?: readonly unknown[];
  }) => void;
}

function isValidSnapshot(value: unknown): value is TelegramDaemonStateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === TELEGRAM_DAEMON_STATE_VERSION &&
    Array.isArray(record.workers) &&
    Array.isArray(record.routes)
  );
}

export function createTelegramDaemonStore(
  ports: TelegramDaemonStorePorts,
): TelegramDaemonStore {
  return {
    load() {
      const text = ports.read();
      if (!text) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return undefined;
      }
      if (!isValidSnapshot(parsed)) return undefined;
      return {
        workers: parsed.workers,
        routes: parsed.routes,
        attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      };
    },
    save(state) {
      const snapshot: TelegramDaemonStateSnapshot = {
        version: TELEGRAM_DAEMON_STATE_VERSION,
        workers: state.workers,
        routes: state.routes,
        attachments: state.attachments ?? [],
      };
      ports.write(`${JSON.stringify(snapshot)}\n`);
    },
  };
}

/** Atomic same-directory replacement for the daemon snapshot file. */
export function createTelegramDaemonFilePorts(
  path: string,
): TelegramDaemonStorePorts {
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    write: (payload) => {
      mkdirSync(dirname(path), { recursive: true });
      const tempPath = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
        renameSync(tempPath, path);
      } catch (error) {
        try {
          unlinkSync(tempPath);
        } catch {
          /* best effort */
        }
        throw error;
      }
    },
  };
}
