/**
 * Proof-only candidate planning for inactive Telegram Workspace Thread cleanup
 * Zones: telegram threads, workspace lifecycle
 * Owns fail-closed cleanup eligibility projection without persistence or Bot API effects
 */

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { renameTelegramPathWithRetry, withTelegramFileTransaction } from "./locks.ts";
import { resolveTelegramThreadCleanupWorkPath } from "./paths.ts";
import { isTelegramTopicTargetStaleError } from "./threads.ts";
import { createTelegramUpdateJournalBotIdentity } from "./journal.ts";
import type { TelegramWorkspaceAdmissionLedger,
  TelegramWorkspaceDeletionPermit,
  TelegramWorkspaceDestructiveFence,
  TelegramWorkspaceRetirementFence } from "./workspace-admission.ts";

export interface TelegramThreadCleanupBindingSnapshot {
  cwd: string;
  workspaceKey: string;
  sessionId?: string;
  sessionKey?: string;
  instanceSlot: string;
  slot?: string;
  bindingKey: string;
  target: { chatId: number; threadId: number };
  inactiveSinceMs?: number;
  updatedAtMs: number;
}

export type TelegramThreadCleanupProtectionState = "clear" | "protected" | "unknown";

export interface TelegramThreadCleanupProtectionEvidence {
  bindingKey: string;
  target: { chatId: number; threadId: number };
  liveOwner: TelegramThreadCleanupProtectionState;
  acceptedWork: TelegramThreadCleanupProtectionState;
  deliveryAuthority: TelegramThreadCleanupProtectionState;
}

export interface TelegramThreadCleanupCandidate {
  profileName: string;
  bindingKey: string;
  cwd: string;
  workspaceKey: string;
  sessionId?: string;
  sessionKey?: string;
  instanceSlot: string;
  slot: string;
  target: { chatId: number; threadId: number };
  inactiveSinceMs: number;
  bindingUpdatedAtMs: number;
}

function targetKey(target: { chatId: number; threadId: number }): string {
  return `${target.chatId}:${target.threadId}`;
}

function validTarget(target: { chatId: number; threadId: number }): boolean {
  return Number.isSafeInteger(target.chatId) && Number.isSafeInteger(target.threadId) &&
    target.threadId > 0;
}

function validSessionIdentity(value: {
  sessionId?: unknown;
  sessionKey?: unknown;
}): boolean {
  if (value.sessionId === undefined && value.sessionKey === undefined) return true;
  if (typeof value.sessionId !== "string" || !value.sessionId ||
      value.sessionId !== value.sessionId.trim() ||
      Buffer.byteLength(value.sessionId, "utf8") > 256 ||
      typeof value.sessionKey !== "string" || !/^[a-f0-9]{64}$/u.test(value.sessionKey)) {
    return false;
  }
  return createHash("sha256").update(value.sessionId).digest("hex") ===
    value.sessionKey;
}

/** Returns no candidates when any identity/evidence ambiguity exists. */
export function planTelegramInactiveThreadCleanup(input: {
  profileName: string;
  bindings: readonly TelegramThreadCleanupBindingSnapshot[];
  protection: readonly TelegramThreadCleanupProtectionEvidence[];
  reservedTargets?: readonly { chatId: number; threadId: number }[];
  provisioningTargets?: readonly { chatId: number; threadId: number }[];
  cleanupTargets?: readonly { chatId: number; threadId: number }[];
  /** Only bindings inactive since at or before this instant are candidates. */
  inactiveBeforeMs?: number;
}): TelegramThreadCleanupCandidate[] {
  if (!input.profileName) return [];
  const bindingKeys = new Set<string>();
  const bindingTargets = new Set<string>();
  for (const binding of input.bindings) {
    const key = targetKey(binding.target);
    const slot = binding.slot;
    if (!binding.bindingKey || !binding.cwd || !binding.workspaceKey || !binding.instanceSlot ||
        typeof slot !== "string" || !slot || !validSessionIdentity(binding) ||
        !validTarget(binding.target) || bindingKeys.has(binding.bindingKey) || bindingTargets.has(key)) return [];
    bindingKeys.add(binding.bindingKey);
    bindingTargets.add(key);
  }
  const evidenceByBinding = new Map<string, TelegramThreadCleanupProtectionEvidence>();
  for (const evidence of input.protection) {
    if (!evidence.bindingKey || evidenceByBinding.has(evidence.bindingKey) || !validTarget(evidence.target)) return [];
    evidenceByBinding.set(evidence.bindingKey, evidence);
  }
  const competingTargets = [
    ...(input.reservedTargets ?? []),
    ...(input.provisioningTargets ?? []),
    ...(input.cleanupTargets ?? []),
  ];
  if (competingTargets.some(target => !validTarget(target))) return [];
  const competing = new Set(competingTargets.map(targetKey));
  const candidates: TelegramThreadCleanupCandidate[] = [];
  for (const binding of input.bindings) {
    const inactiveSinceMs = binding.inactiveSinceMs;
    const slot = binding.slot;
    if (typeof slot !== "string" || !slot || !Number.isSafeInteger(inactiveSinceMs) ||
        inactiveSinceMs === undefined || inactiveSinceMs < 0 ||
        !Number.isSafeInteger(binding.updatedAtMs) || binding.updatedAtMs < inactiveSinceMs) continue;
    if (input.inactiveBeforeMs !== undefined &&
        inactiveSinceMs > input.inactiveBeforeMs) continue;
    const evidence = evidenceByBinding.get(binding.bindingKey);
    if (!evidence || targetKey(evidence.target) !== targetKey(binding.target) ||
        evidence.liveOwner !== "clear" || evidence.acceptedWork !== "clear" ||
        evidence.deliveryAuthority !== "clear" || competing.has(targetKey(binding.target))) continue;
    candidates.push({ profileName: input.profileName, bindingKey: binding.bindingKey,
      cwd: binding.cwd, workspaceKey: binding.workspaceKey,
      ...(binding.sessionId && binding.sessionKey
        ? { sessionId: binding.sessionId, sessionKey: binding.sessionKey }
        : {}),
      instanceSlot: binding.instanceSlot, slot, target: { ...binding.target }, inactiveSinceMs,
      bindingUpdatedAtMs: binding.updatedAtMs });
  }
  return candidates.sort((left, right) => left.bindingKey.localeCompare(right.bindingKey));
}

export function captureTelegramInactiveThreadCleanupEvidence<
  TBinding extends TelegramThreadCleanupBindingSnapshot,
>(input: {
  profileName: string;
  listBindings(): readonly TBinding[];
  getProtection(binding: TBinding): {
    liveOwner: TelegramThreadCleanupProtectionState;
    acceptedWork: TelegramThreadCleanupProtectionState;
    deliveryAuthority: TelegramThreadCleanupProtectionState;
  };
  listReservations(): readonly { target: { chatId: number; threadId: number } }[];
  listPendingProvisions(): readonly { target?: { chatId: number; threadId: number } }[];
  listPendingCleanups(): readonly { target: { chatId: number; threadId: number } }[];
}): Parameters<typeof planTelegramInactiveThreadCleanup>[0] {
  const sourceBindings = input.listBindings();
  const bindings = sourceBindings.map(binding => ({
    cwd: binding.cwd, workspaceKey: binding.workspaceKey,
    ...(binding.sessionId && binding.sessionKey
      ? { sessionId: binding.sessionId, sessionKey: binding.sessionKey }
      : {}),
    instanceSlot: binding.instanceSlot,
    ...(binding.slot === undefined ? {} : { slot: binding.slot }), bindingKey: binding.bindingKey, target: { ...binding.target },
    ...(binding.inactiveSinceMs === undefined ? {} : { inactiveSinceMs: binding.inactiveSinceMs }),
    updatedAtMs: binding.updatedAtMs,
  }));
  const protection = sourceBindings.map((source, index) => {
    const binding = bindings[index]!;
    try { return { bindingKey: binding.bindingKey, target: { ...binding.target },
      ...input.getProtection(source) }; }
    catch { return { bindingKey: binding.bindingKey, target: { ...binding.target },
      liveOwner: "unknown" as const, acceptedWork: "unknown" as const,
      deliveryAuthority: "unknown" as const }; }
  });
  return {
    profileName: input.profileName,
    bindings,
    protection,
    reservedTargets: input.listReservations().map(entry => ({ ...entry.target })),
    provisioningTargets: input.listPendingProvisions().flatMap(entry =>
      entry.target ? [{ ...entry.target }] : []),
    cleanupTargets: input.listPendingCleanups().map(entry => ({ ...entry.target })),
  };
}

export function createTelegramInactiveThreadCleanupReviewRuntime<
  TBinding extends TelegramThreadCleanupBindingSnapshot,
>(deps: {
  getProfileName(): string;
  listBindings(): readonly TBinding[];
  getProtection(binding: TBinding): {
    liveOwner: TelegramThreadCleanupProtectionState;
    acceptedWork: TelegramThreadCleanupProtectionState;
    deliveryAuthority: TelegramThreadCleanupProtectionState;
  };
  listReservations(): readonly { target: { chatId: number; threadId: number } }[];
  listPendingProvisions(): readonly { target?: { chatId: number; threadId: number } }[];
  listPendingCleanups(): readonly { target: { chatId: number; threadId: number } }[];
  getWorkStore(): TelegramThreadCleanupWorkStore;
  runWorkspaceOperation<T>(input: { operationId: string; operationKind: string;
    scopes: readonly [{ kind: "profile" }] }, operation: () => Promise<T>): Promise<T>;
}): {
  review(options?: { inactiveBeforeMs?: number }): Promise<{ count: number; operationId?: string }>;
} {
  return {
    review(options) {
      return deps.runWorkspaceOperation({ operationId: `thread-cleanup-review:${randomUUID()}`,
        operationKind: "thread-cleanup-review", scopes: [{ kind: "profile" }] }, async () => {
        const evidence = captureTelegramInactiveThreadCleanupEvidence({
          profileName: deps.getProfileName(), listBindings: deps.listBindings,
          getProtection: deps.getProtection, listReservations: deps.listReservations,
          listPendingProvisions: deps.listPendingProvisions,
          listPendingCleanups: deps.listPendingCleanups,
        });
        const candidates = planTelegramInactiveThreadCleanup({
          ...evidence,
          ...(options?.inactiveBeforeMs !== undefined
            ? { inactiveBeforeMs: options.inactiveBeforeMs }
            : {}),
        });
        if (candidates.length === 0) return { count: 0 };
        const digest = createHash("sha256").update(JSON.stringify(candidates)).digest("hex").slice(0, 32);
        const operationId = `thread-cleanup:${digest}`;
        deps.getWorkStore().prepare(operationId, candidates);
        return { count: candidates.length, operationId };
      });
    },
  };
}

export type TelegramThreadCleanupWorkState = "prepared" | "outcome-unknown" | "deleted";
export type TelegramThreadCleanupWorkEntry = TelegramThreadCleanupCandidate & {
  state: TelegramThreadCleanupWorkState;
  updatedAtMs: number;
  issuedAtMs?: number;
  permitOperationId?: string;
  permitIntentId?: string;
  permitLeaderEpoch?: number | string;
  deletedAtMs?: number;
};
export interface TelegramThreadCleanupWorkSet {
  operationId: string;
  createdAtMs: number;
  entries: TelegramThreadCleanupWorkEntry[];
}
interface TelegramThreadCleanupWorkFile {
  version: 1;
  profileName: string;
  tokenSha256: string;
  workSets: TelegramThreadCleanupWorkSet[];
}
export type TelegramThreadCleanupDeletionPermit = TelegramWorkspaceDeletionPermit;
export type TelegramThreadCleanupFence = TelegramWorkspaceRetirementFence;

export interface TelegramThreadCleanupWorkStore {
  prepare(operationId: string, candidates: readonly TelegramThreadCleanupCandidate[]):
    { prepared: boolean; workSet: TelegramThreadCleanupWorkSet };
  recordDeletionIssued(input: { operationId: string; bindingKey: string; bindingUpdatedAtMs: number;
    permit: TelegramThreadCleanupDeletionPermit }):
    { recorded: boolean; entry: TelegramThreadCleanupWorkEntry };
  confirmDeleted(input: { operationId: string; bindingKey: string }):
    { confirmed: boolean; entry: TelegramThreadCleanupWorkEntry };
  list(): TelegramThreadCleanupWorkSet[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys); return Object.keys(value).every(key => allowed.has(key));
}
function safeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validateWorkSet(value: unknown, profileName: string): TelegramThreadCleanupWorkSet {
  if (!isObject(value) || !onlyKeys(value, ["operationId", "createdAtMs", "entries"]) ||
      typeof value.operationId !== "string" || !value.operationId || !safeTime(value.createdAtMs) ||
      !Array.isArray(value.entries) || value.entries.length === 0) throw new Error("Telegram Thread cleanup work-set schema is invalid.");
  const createdAtMs = value.createdAtMs as number;
  const entries = value.entries.map(raw => {
    if (!isObject(raw) || !onlyKeys(raw, ["profileName", "bindingKey", "cwd", "workspaceKey",
      "sessionId", "sessionKey", "instanceSlot", "slot", "target", "inactiveSinceMs", "bindingUpdatedAtMs", "state", "updatedAtMs",
      "issuedAtMs", "permitOperationId", "permitIntentId", "permitLeaderEpoch", "deletedAtMs"]) || raw.profileName !== profileName || typeof raw.bindingKey !== "string" ||
      !raw.bindingKey || typeof raw.cwd !== "string" || !raw.cwd || typeof raw.workspaceKey !== "string" ||
      !raw.workspaceKey || !validSessionIdentity(raw) ||
      typeof raw.instanceSlot !== "string" || !raw.instanceSlot ||
      typeof raw.slot !== "string" || !raw.slot || !isObject(raw.target) ||
      !onlyKeys(raw.target, ["chatId", "threadId"]) || !validTarget(raw.target as unknown as { chatId: number; threadId: number }) ||
      !safeTime(raw.inactiveSinceMs) || !safeTime(raw.bindingUpdatedAtMs) ||
      (raw.bindingUpdatedAtMs as number) < (raw.inactiveSinceMs as number) || !safeTime(raw.updatedAtMs))
      throw new Error("Telegram Thread cleanup entry schema is invalid.");
    const base = { profileName, bindingKey: raw.bindingKey, cwd: raw.cwd, workspaceKey: raw.workspaceKey,
      ...(typeof raw.sessionId === "string" && typeof raw.sessionKey === "string"
        ? { sessionId: raw.sessionId, sessionKey: raw.sessionKey }
        : {}),
      instanceSlot: raw.instanceSlot, slot: raw.slot, target: { chatId: raw.target.chatId as number,
        threadId: raw.target.threadId as number }, inactiveSinceMs: raw.inactiveSinceMs as number,
      bindingUpdatedAtMs: raw.bindingUpdatedAtMs as number, updatedAtMs: raw.updatedAtMs as number };
    if (base.updatedAtMs < base.bindingUpdatedAtMs) throw new Error("Telegram Thread cleanup entry clock is invalid.");
    const noPermit = raw.permitOperationId === undefined && raw.permitIntentId === undefined &&
      raw.permitLeaderEpoch === undefined;
    if (raw.state === "prepared" && raw.issuedAtMs === undefined && raw.deletedAtMs === undefined && noPermit)
      return { ...base, state: "prepared" as const };
    const validPermit = typeof raw.permitOperationId === "string" && !!raw.permitOperationId &&
      typeof raw.permitIntentId === "string" && !!raw.permitIntentId &&
      (typeof raw.permitLeaderEpoch === "string" || Number.isSafeInteger(raw.permitLeaderEpoch));
    if (raw.state === "outcome-unknown" && safeTime(raw.issuedAtMs) && validPermit &&
        raw.issuedAtMs === base.updatedAtMs && raw.deletedAtMs === undefined)
      return { ...base, state: "outcome-unknown" as const, issuedAtMs: raw.issuedAtMs,
        permitOperationId: raw.permitOperationId as string, permitIntentId: raw.permitIntentId as string,
        permitLeaderEpoch: raw.permitLeaderEpoch as number | string };
    if (raw.state === "deleted" && safeTime(raw.issuedAtMs) && validPermit && safeTime(raw.deletedAtMs) &&
        raw.deletedAtMs === base.updatedAtMs && raw.deletedAtMs >= raw.issuedAtMs)
      return { ...base, state: "deleted" as const, issuedAtMs: raw.issuedAtMs,
        permitOperationId: raw.permitOperationId as string, permitIntentId: raw.permitIntentId as string,
        permitLeaderEpoch: raw.permitLeaderEpoch as number | string, deletedAtMs: raw.deletedAtMs };
    throw new Error("Telegram Thread cleanup entry state is invalid.");
  });
  if (entries.some(entry => entry.updatedAtMs < createdAtMs) ||
      new Set(entries.map(entry => entry.bindingKey)).size !== entries.length ||
      new Set(entries.map(entry => targetKey(entry.target))).size !== entries.length)
    throw new Error("Telegram Thread cleanup work-set identity is ambiguous.");
  return { operationId: value.operationId, createdAtMs, entries };
}

function sameCandidates(left: readonly TelegramThreadCleanupCandidate[], right: readonly TelegramThreadCleanupCandidate[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createTelegramThreadCleanupWorkStore(options: {
  path: string; profileName: string; tokenSha256: string; maxWorkSets?: number;
  maxBytes?: number; getNowMs?: () => number;
  onPublicationBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void;
}): TelegramThreadCleanupWorkStore {
  const maxWorkSets = options.maxWorkSets ?? 32;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const now = options.getNowMs ?? Date.now;
  if (!options.path || !options.profileName || !/^[a-f0-9]{64}$/u.test(options.tokenSha256) ||
      !Number.isSafeInteger(maxWorkSets) || maxWorkSets <= 0 ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Telegram Thread cleanup store options are invalid.");
  const empty = (): TelegramThreadCleanupWorkFile => ({ version: 1, profileName: options.profileName,
    tokenSha256: options.tokenSha256, workSets: [] });
  const read = (): TelegramThreadCleanupWorkFile => {
    let before;
    try { before = lstatSync(options.path, { bigint: true }); }
    catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return empty();
      throw error;
    }
    const uid = process.getuid?.();
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK || uid === undefined || !before.isFile() ||
        before.isSymbolicLink() || before.uid !== BigInt(uid) || before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n || before.size > BigInt(maxBytes))
      throw new Error("Telegram Thread cleanup store is not a bounded private regular file.");
    const fd = openSync(options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
          opened.mtimeNs !== before.mtimeNs) throw new Error("Telegram Thread cleanup store changed during inspection.");
      value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    } finally { closeSync(fd); }
    if (!isObject(value) || !onlyKeys(value, ["version", "profileName", "tokenSha256", "workSets"]) ||
        value.version !== 1 || value.profileName !== options.profileName ||
        value.tokenSha256 !== options.tokenSha256 || !Array.isArray(value.workSets))
      throw new Error("Telegram Thread cleanup store identity or schema does not match.");
    const workSets = value.workSets.map(workSet => validateWorkSet(workSet, options.profileName));
    if (new Set(workSets.map(workSet => workSet.operationId)).size !== workSets.length)
      throw new Error("Telegram Thread cleanup operation identity is ambiguous.");
    return { version: 1, profileName: options.profileName, tokenSha256: options.tokenSha256, workSets };
  };
  const publish = (file: TelegramThreadCleanupWorkFile): void => {
    if (file.workSets.length > maxWorkSets) throw new Error("Telegram Thread cleanup work-set capacity reached.");
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) throw new Error("Telegram Thread cleanup byte capacity reached.");
    const temporaryPath = `${options.path}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temporaryPath, serialized, { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      options.onPublicationBoundary?.("after-write-before-rename");
      if (!renameTelegramPathWithRetry(temporaryPath, options.path))
        throw new Error("Telegram Thread cleanup staging file disappeared.");
      chmodSync(options.path, 0o600);
      options.onPublicationBoundary?.("after-rename");
    } finally { try { unlinkSync(temporaryPath); } catch { /* rename consumed it */ } }
  };
  const mutate = <T>(operation: (file: TelegramThreadCleanupWorkFile) => T): T =>
    withTelegramFileTransaction(`${options.path}.transaction`, () => operation(read()));
  return {
    prepare(operationId, candidates) {
      if (!operationId || candidates.length === 0 || candidates.some(candidate => candidate.profileName !== options.profileName))
        throw new Error("Telegram Thread cleanup work-set is invalid.");
      return mutate(file => {
        const existing = file.workSets.find(workSet => workSet.operationId === operationId);
        if (existing) {
          const projected = existing.entries.map(({ state: _state, updatedAtMs: _updated,
            issuedAtMs: _issued, permitOperationId: _permitOperation,
            permitIntentId: _permitIntent, permitLeaderEpoch: _permitEpoch,
            deletedAtMs: _deleted, ...candidate }) => candidate);
          if (!sameCandidates(projected, candidates)) throw new Error("Telegram Thread cleanup operation conflicts.");
          return { prepared: false, workSet: structuredClone(existing) };
        }
        const atMs = now();
        if (!safeTime(atMs)) throw new Error("Telegram Thread cleanup clock is invalid.");
        const workSet = validateWorkSet({ operationId, createdAtMs: atMs,
          entries: candidates.map(candidate => ({ ...structuredClone(candidate), state: "prepared", updatedAtMs: atMs })) },
        options.profileName);
        publish({ ...file, workSets: [...file.workSets, workSet] });
        return { prepared: true, workSet: structuredClone(workSet) };
      });
    },
    recordDeletionIssued(input) {
      return mutate(file => {
        const workSet = file.workSets.find(candidate => candidate.operationId === input.operationId);
        const entry = workSet?.entries.find(candidate => candidate.bindingKey === input.bindingKey);
        const permit = input.permit;
        if (!workSet || !entry || entry.bindingUpdatedAtMs !== input.bindingUpdatedAtMs ||
            permit.destructiveKind !== "manual-thread-cleanup" || permit.profileKey !== entry.profileName || permit.bindingKey !== entry.bindingKey ||
            permit.slot !== entry.slot || targetKey(permit.target) !== targetKey(entry.target) ||
            !permit.operationId || !permit.retirementIntentId || !safeTime(permit.issuedAtMs))
          throw new Error("Telegram Thread cleanup entry or deletion permit is stale or mismatched.");
        if (entry.state !== "prepared") {
          const exact = entry.permitOperationId === permit.operationId &&
            entry.permitIntentId === permit.retirementIntentId &&
            entry.permitLeaderEpoch === permit.leaderEpoch;
          if (!exact) throw new Error("Telegram Thread cleanup deletion permit conflicts with retained work.");
          return { recorded: false, entry: structuredClone(entry) };
        }
        const atMs = now();
        if (!safeTime(atMs) || atMs < entry.updatedAtMs || atMs < permit.issuedAtMs)
          throw new Error("Telegram Thread cleanup clock is invalid.");
        entry.state = "outcome-unknown"; entry.issuedAtMs = atMs; entry.updatedAtMs = atMs;
        entry.permitOperationId = permit.operationId; entry.permitIntentId = permit.retirementIntentId;
        entry.permitLeaderEpoch = permit.leaderEpoch;
        publish(file); return { recorded: true, entry: structuredClone(entry) };
      });
    },
    confirmDeleted(input) {
      return mutate(file => {
        const entry = file.workSets.find(candidate => candidate.operationId === input.operationId)
          ?.entries.find(candidate => candidate.bindingKey === input.bindingKey);
        if (!entry) throw new Error("Telegram Thread cleanup entry is missing.");
        if (entry.state === "deleted") return { confirmed: false, entry: structuredClone(entry) };
        if (entry.state !== "outcome-unknown") throw new Error("Telegram Thread cleanup deletion confirmation is premature.");
        const atMs = now();
        if (!safeTime(atMs) || atMs < entry.updatedAtMs) throw new Error("Telegram Thread cleanup clock is invalid.");
        entry.state = "deleted"; entry.deletedAtMs = atMs; entry.updatedAtMs = atMs;
        publish(file); return { confirmed: true, entry: structuredClone(entry) };
      });
    },
    list() { return structuredClone(read().workSets); },
  };
}

export async function commitTelegramInactiveThreadCleanup(input: {
  store: TelegramThreadCleanupWorkStore;
  operationId: string;
  bindingKey: string;
  commitBinding(): Promise<boolean>;
}): Promise<boolean> {
  if (!await input.commitBinding()) return false;
  input.store.confirmDeleted({ operationId: input.operationId, bindingKey: input.bindingKey });
  return true;
}

export async function executeTelegramInactiveThreadCleanup(input: {
  store: TelegramThreadCleanupWorkStore;
  operationId: string;
  bindingKey: string;
  withWorkspaceDeletionBoundary<T>(operation: () => Promise<T>): Promise<T>;
  loadFreshEvidence(): Promise<Parameters<typeof planTelegramInactiveThreadCleanup>[0]>;
  acquireDeletionPermit(candidate: TelegramThreadCleanupCandidate): Promise<
    | { kind: "issued"; permit: TelegramThreadCleanupDeletionPermit }
    | { kind: "blocked" | "already-issued" }
  >;
  deleteWithPermit(permit: TelegramThreadCleanupDeletionPermit,
    candidate: TelegramThreadCleanupCandidate): Promise<void>;
}): Promise<{ status: "deleted" | "blocked" | "outcome-unknown";
  entry?: TelegramThreadCleanupWorkEntry }> {
  return input.withWorkspaceDeletionBoundary(async () => {
    const workSet = input.store.list().find(candidate => candidate.operationId === input.operationId);
    const retained = workSet?.entries.find(candidate => candidate.bindingKey === input.bindingKey);
    if (!retained) return { status: "blocked" };
    if (retained.state === "deleted") return { status: "deleted", entry: retained };
    if (retained.state === "outcome-unknown") return { status: "outcome-unknown", entry: retained };
    const planned = planTelegramInactiveThreadCleanup(await input.loadFreshEvidence());
    const fresh = planned.find(candidate => candidate.bindingKey === retained.bindingKey);
    const retainedCandidate = (({ state: _state, updatedAtMs: _updated, issuedAtMs: _issued,
      permitOperationId: _permitOperation, permitIntentId: _permitIntent,
      permitLeaderEpoch: _permitEpoch, deletedAtMs: _deleted, ...candidate }) => candidate)(retained);
    if (!fresh || !sameCandidates([fresh], [retainedCandidate])) return { status: "blocked" };
    const permitResult = await input.acquireDeletionPermit(fresh);
    if (permitResult.kind !== "issued") return { status: "blocked" };
    const recorded = input.store.recordDeletionIssued({ operationId: input.operationId,
      bindingKey: input.bindingKey, bindingUpdatedAtMs: retained.bindingUpdatedAtMs,
      permit: permitResult.permit });
    if (!recorded.recorded) return { status: "outcome-unknown", entry: recorded.entry };
    await input.deleteWithPermit(permitResult.permit, fresh);
    const confirmed = input.store.confirmDeleted({ operationId: input.operationId,
      bindingKey: input.bindingKey });
    return { status: "deleted", entry: confirmed.entry };
  });
}

export function createTelegramThreadCleanupPermitRuntime(deps: {
  ledger: {
    read(): { fence?: TelegramWorkspaceDestructiveFence };
    acquireThreadCleanupFence(input: { operationId: string; cleanupWorkSetId: string;
      bindingKey: string; slot: string; target: { chatId: number; threadId: number };
      leaderEpoch: number | string; cleanupRequestedAtMs: number }):
      | { kind: "acquired"; fence: TelegramThreadCleanupFence; resumed: boolean }
      | { kind: "blocked"; reason: string };
    adoptThreadCleanupFence(fence: TelegramThreadCleanupFence, replacement: {
      owner: { processId: number; processBirthId: string }; leaderEpoch: number | string;
    }): TelegramThreadCleanupFence;
    issueThreadCleanupDeletionPermit(fence: TelegramThreadCleanupFence):
      | { kind: "issued"; fence: TelegramThreadCleanupFence; permit: TelegramThreadCleanupDeletionPermit }
      | { kind: "already-issued"; fence: TelegramThreadCleanupFence };
    confirmThreadCleanupAbsence(fence: TelegramThreadCleanupFence): TelegramThreadCleanupFence;
    releaseUnissuedThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
    /** Release a fence whose deletion provably failed; retrying the delete is idempotent. */
    releaseFailedThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
    completeThreadCleanupFence(fence: TelegramThreadCleanupFence): boolean;
  };
  getLeaderEpoch(): number | string | undefined;
  getProfileName(): string;
  getOwner(): { processId: number; processBirthId: string };
  canAdoptFence(fence: TelegramThreadCleanupFence): boolean;
  revalidateUnderFence(candidate: TelegramThreadCleanupCandidate): Promise<boolean>;
  getNowMs?: () => number;
}): {
  acquire(candidate: TelegramThreadCleanupCandidate, workSetId: string): Promise<
    | { kind: "issued"; fence: TelegramThreadCleanupFence; permit: TelegramThreadCleanupDeletionPermit }
    | { kind: "blocked" }
    | { kind: "already-issued" }
  >;
  diagnoseRecovery(candidate: TelegramThreadCleanupCandidate, workSetId: string):
    "none" | "fenced" | "deletion-issued" | "commit-ready" | "authority-blocked";
  findCommitReady(candidate: TelegramThreadCleanupCandidate,
    workSetId: string): TelegramThreadCleanupFence | undefined;
  settleDeleted(fence: TelegramThreadCleanupFence,
    commit: () => Promise<boolean>): Promise<"completed" | "commit-pending">;
} {
  const now = deps.getNowMs ?? Date.now;
  const findExactFence = (candidate: TelegramThreadCleanupCandidate, workSetId: string) => {
    const operationId = `thread-cleanup-fence:${createHash("sha256").update(
      `${workSetId}\u0000${candidate.bindingKey}`, "utf8").digest("hex")}`;
    const fence = deps.ledger.read().fence;
    return fence?.operationId === operationId && fence.destructiveKind === "manual-thread-cleanup" &&
      fence.profileKey === candidate.profileName && fence.retirementIntentId === workSetId && fence.bindingKey === candidate.bindingKey &&
      fence.slot === candidate.slot && targetKey(fence.target) === targetKey(candidate.target)
      ? fence : undefined;
  };
  const adoptExactFence = (candidate: TelegramThreadCleanupCandidate, workSetId: string) => {
    let fence = findExactFence(candidate, workSetId);
    const leaderEpoch = deps.getLeaderEpoch();
    if (!fence || leaderEpoch === undefined) return undefined;
    const owner = deps.getOwner();
    if (fence.leaderEpoch !== leaderEpoch || fence.owner.processId !== owner.processId ||
        fence.owner.processBirthId !== owner.processBirthId) {
      if (!deps.canAdoptFence(fence)) return undefined;
      try { fence = deps.ledger.adoptThreadCleanupFence(fence,
        { owner, leaderEpoch }); } catch { return undefined; }
    }
    return deps.getLeaderEpoch() === leaderEpoch ? fence : undefined;
  };
  return {
    diagnoseRecovery(candidate, workSetId) {
      const fence = deps.ledger.read().fence;
      if (!fence) return "none";
      const exact = findExactFence(candidate, workSetId);
      if (!exact) return "authority-blocked";
      const owner = deps.getOwner();
      const leaderEpoch = deps.getLeaderEpoch();
      const owns = exact.owner.processId === owner.processId &&
        exact.owner.processBirthId === owner.processBirthId && exact.leaderEpoch === leaderEpoch;
      return owns || deps.canAdoptFence(exact) ? exact.phase : "authority-blocked";
    },
    findCommitReady(candidate, workSetId) {
      const fence = adoptExactFence(candidate, workSetId);
      return fence?.phase === "commit-ready" ? fence : undefined;
    },
    async acquire(candidate, workSetId) {
      const leaderEpoch = deps.getLeaderEpoch();
      if (leaderEpoch === undefined || candidate.profileName.length === 0 ||
          candidate.profileName !== deps.getProfileName()) return { kind: "blocked" };
      const operationId = `thread-cleanup-fence:${createHash("sha256")
        .update(workSetId).update("\0").update(candidate.bindingKey).digest("hex")}`;
      const existing = adoptExactFence(candidate, workSetId) ?? deps.ledger.read().fence;
      if (existing && existing.operationId === operationId &&
          existing.destructiveKind === "manual-thread-cleanup" &&
          existing.retirementIntentId === workSetId && existing.bindingKey === candidate.bindingKey &&
          existing.slot === candidate.slot && targetKey(existing.target) === targetKey(candidate.target) &&
          existing.leaderEpoch === leaderEpoch && existing.phase !== "fenced") {
        return { kind: "already-issued" };
      }
      let acquired;
      try {
        acquired = deps.ledger.acquireThreadCleanupFence({ operationId,
          cleanupWorkSetId: workSetId, bindingKey: candidate.bindingKey, slot: candidate.slot,
          target: candidate.target, leaderEpoch, cleanupRequestedAtMs: now() });
      } catch { return { kind: "blocked" }; }
      if (acquired.kind === "blocked") return { kind: "blocked" };
      if (deps.getLeaderEpoch() !== leaderEpoch || !await deps.revalidateUnderFence(candidate)) {
        if (acquired.fence.phase === "fenced") deps.ledger.releaseUnissuedThreadCleanupFence(acquired.fence);
        return { kind: "blocked" };
      }
      const issued = deps.ledger.issueThreadCleanupDeletionPermit(acquired.fence);
      return issued.kind === "issued"
        ? { kind: "issued", fence: issued.fence, permit: issued.permit }
        : { kind: "already-issued" };
    },
    async settleDeleted(fence, commit) {
      const ready = deps.ledger.confirmThreadCleanupAbsence(fence);
      if (!await commit()) return "commit-pending";
      deps.ledger.completeThreadCleanupFence(ready);
      return "completed";
    },
  };
}


export interface TelegramInactiveThreadCleanupCoordinatorDeps<TBinding> {
  store: TelegramThreadCleanupWorkStore;
  permitRuntime: ReturnType<typeof createTelegramThreadCleanupPermitRuntime>;
  resolveFullBinding(candidate: TelegramThreadCleanupCandidate): Promise<TBinding | undefined>;
  deleteWithPermit(permit: TelegramThreadCleanupDeletionPermit,
    candidate: TelegramThreadCleanupCandidate): Promise<void>;
  commitBinding(candidate: TelegramThreadCleanupCandidate,
    currentBinding?: TBinding): Promise<boolean>;
}

export function createTelegramInactiveThreadCleanupSettingsPort<TBinding>(
  deps: TelegramInactiveThreadCleanupCoordinatorDeps<TBinding>,
): (operationId: string) => Promise<TelegramInactiveThreadCleanupResult> {
  return operationId => cleanReviewedInactiveThreads({ ...deps, operationId });
}

export interface TelegramInactiveThreadCleanupResult {
  deleted: number;
  outcomeUnknown: number;
  blocked: number;
  recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
}

export async function cleanReviewedInactiveThreads<TBinding>(input: {
  operationId: string;
} & TelegramInactiveThreadCleanupCoordinatorDeps<TBinding>): Promise<TelegramInactiveThreadCleanupResult> {
  if (!/^thread-cleanup:[a-f0-9]{32}$/u.test(input.operationId))
    throw new Error("Telegram Thread cleanup confirmation identity is invalid.");
  const workSet = input.store.list().find(candidate => candidate.operationId === input.operationId);
  if (!workSet) throw new Error("Telegram Thread cleanup review is missing.");
  let deleted = 0;
  let outcomeUnknown = 0;
  let blocked = 0;
  for (const entry of workSet.entries) {
    if (entry.state === "deleted") {
      const ready = input.permitRuntime.findCommitReady(entry, input.operationId);
      if (ready) await input.permitRuntime.settleDeleted(ready, async () => true);
      deleted += 1;
      continue;
    }
    if (entry.state === "outcome-unknown") {
      const ready = input.permitRuntime.findCommitReady(entry, input.operationId);
      if (!ready) { outcomeUnknown += 1; continue; }
      const settlement = await input.permitRuntime.settleDeleted(ready, () =>
        commitTelegramInactiveThreadCleanup({ store: input.store, operationId: input.operationId,
          bindingKey: entry.bindingKey, commitBinding: () => input.commitBinding(entry) }));
      if (settlement === "completed") deleted += 1;
      else outcomeUnknown += 1;
      continue;
    }
    const fullBinding = await input.resolveFullBinding(entry);
    if (!fullBinding) { blocked += 1; continue; }
    const authority = await input.permitRuntime.acquire(entry, input.operationId);
    if (authority.kind === "blocked") { blocked += 1; continue; }
    if (authority.kind === "already-issued") { outcomeUnknown += 1; continue; }
    try {
      const recorded = input.store.recordDeletionIssued({ operationId: input.operationId,
        bindingKey: entry.bindingKey, bindingUpdatedAtMs: entry.bindingUpdatedAtMs,
        permit: authority.permit,
      });
      if (!recorded.recorded) {
        if (recorded.entry.state === "deleted") {
          const settlement = await input.permitRuntime.settleDeleted(authority.fence, async () => true);
          if (settlement === "completed") deleted += 1;
          else outcomeUnknown += 1;
        } else outcomeUnknown += 1;
        continue;
      }
      await input.deleteWithPermit(authority.permit, entry);
      const settlement = await input.permitRuntime.settleDeleted(authority.fence, () =>
        commitTelegramInactiveThreadCleanup({ store: input.store, operationId: input.operationId,
          bindingKey: entry.bindingKey, commitBinding: () => input.commitBinding(entry, fullBinding) }));
      if (settlement === "completed") deleted += 1;
      else outcomeUnknown += 1;
    } catch {
      outcomeUnknown += 1;
    }
  }
  const retainedEntries = input.store.list().find(
    candidate => candidate.operationId === input.operationId)?.entries ?? [];
  if (outcomeUnknown > 0) {
    const diagnosis = retainedEntries.map(entry =>
      input.permitRuntime.diagnoseRecovery(entry, input.operationId)).find(value => value !== "none") ?? "none";
    const recovery = diagnosis === "commit-ready" ? "commit-ready"
      : diagnosis === "deletion-issued" ? "deletion-outcome-unknown" : "authority-blocked";
    return { deleted, outcomeUnknown, blocked, recovery };
  }
  return { deleted, outcomeUnknown, blocked };
}

export interface TelegramInactiveThreadCleanupRuntimeDeps<
  TBinding extends TelegramThreadCleanupBindingSnapshot,
> {
  getProfileName(): string;
  getBotToken(): string | undefined;
  getLeaderEpoch(): number | string | undefined;
  getOwner(): { processId: number; processBirthId: string };
  listBindings(): readonly TBinding[];
  getProtection(binding: TBinding): {
    liveOwner: TelegramThreadCleanupProtectionState;
    acceptedWork: TelegramThreadCleanupProtectionState;
    deliveryAuthority: TelegramThreadCleanupProtectionState;
  };
  listReservations(): readonly { target: { chatId: number; threadId: number } }[];
  listPendingProvisions(): readonly { target?: { chatId: number; threadId: number } }[];
  listPendingCleanups(): readonly { target: { chatId: number; threadId: number } }[];
  getAdmissionLedger(): TelegramWorkspaceAdmissionLedger | undefined;
  resolveFullBinding(
    candidate: TelegramThreadCleanupCandidate,
  ): Promise<TBinding | undefined>;
  deleteTopic(target: { chatId: number; threadId: number }): Promise<void>;
  markStaleByTarget(candidate: TelegramThreadCleanupCandidate): Promise<void>;
  commitInactiveWorkspaceCleanup(
    candidate: TelegramThreadCleanupCandidate,
    isCurrent: () => boolean,
  ): Promise<boolean>;
  /** Adoption requires proof that the fenced owner is dead; anything else fails closed. */
  canAdoptFence(owner: { processId: number; processBirthId: string }): boolean;
  /** Absolute path of the Workspace admission ledger, for legacy fence cleanup. */
  resolveAdmissionPath?(): string | undefined;
  /** Redacted diagnostics for a failed or ambiguous cleanup step. */
  recordEvent?(
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ): void;
  runWorkspaceOperation<T>(
    input: {
      operationId: string;
      operationKind: string;
      scopes: readonly [{ kind: "profile" }];
    },
    operation: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Leader-side inactive Workspace Thread cleanup: proof-only review plus the destructive
 * completion of exactly one retained review, under a profile-singleton cleanup fence.
 *
 * Review never deletes. Deletion is driven by the operator's panel or by the daemon's
 * unattended janitor, and always revalidates fresh protection evidence under the fence.
 */
export function createTelegramInactiveThreadCleanupRuntime<
  TBinding extends TelegramThreadCleanupBindingSnapshot,
>(deps: TelegramInactiveThreadCleanupRuntimeDeps<TBinding>): {
  review(options?: {
    inactiveBeforeMs?: number;
  }): Promise<{ count: number; operationId?: string }>;
  deleteReviewed(
    operationId: string,
  ): Promise<TelegramInactiveThreadCleanupResult>;
  /**
   * Proof-only counts with no work-set writes: how many candidates the age cutoff
   * admits, and how many provable candidates it held back as still too young.
   */
  /**
   * Resolve a cleanup fence left behind by an earlier attempt. A permit that was issued
   * but never confirmed keeps the profile admission blocked, so cleanup must finish or
   * retry it before anything else can run.
   */
  /**
   * Delete every currently eligible inactive Thread directly.
   *
   * Deliberately not using the admission fence/permit/work-set machinery: that path could
   * not resolve an interrupted deletion and blocked every profile admission, including
   * daemon startup. Safety comes from the proof-only planner instead — eligibility and
   * evidence are recomputed immediately before each candidate, and the binding is only
   * committed after Telegram confirms that delete.
   */
  deleteEligible(options?: { inactiveBeforeMs?: number }): Promise<{
    deleted: number;
    blocked: number;
  }>;
  /** Remove a legacy cleanup fence that would otherwise block every profile admission. */
  sweepStaleCleanupFence(): { cleared: boolean; backupPath?: string };
  recoverUnresolvedFence(): Promise<{
    status: "none" | "recovered" | "blocked";
    reason?: string;
    /** Whether the admission ledger was readable and held a fence at that moment. */
    sawLedger?: boolean;
    sawFence?: boolean;
  }>;
  survey(options: { inactiveBeforeMs: number }): Promise<{
    cleanable: number;
    tooYoung: number;
    /** Dormant bindings held back by protection evidence that is not `clear`. */
    blockedByEvidence: number;
    /** Dormant bindings held back by a competing reservation, provision, or cleanup. */
    blockedByCompeting: number;
  }>;
} {
  const getWorkStore = () => {
    const profileName = deps.getProfileName();
    const botToken = deps.getBotToken();
    if (!botToken) {
      throw new Error("Telegram Thread cleanup requires an active bot token.");
    }
    return createTelegramThreadCleanupWorkStore({
      path: resolveTelegramThreadCleanupWorkPath(undefined, profileName),
      profileName,
      tokenSha256: createTelegramUpdateJournalBotIdentity({ botToken }).tokenSha256,
    });
  };
  const readStoredCleanupFence = (): TelegramThreadCleanupFence | undefined => {
    const fence = deps.getAdmissionLedger()?.read().fence;
    // The ledger can also hold a journal-writer closure fence, which is not a
    // destructive retirement fence and is not ours to resolve.
    if (!fence || !("retirementIntentId" in fence)) return undefined;
    return fence;
  };
  const captureEvidence = () => captureTelegramInactiveThreadCleanupEvidence({
    profileName: deps.getProfileName(),
    listBindings: deps.listBindings,
    getProtection: deps.getProtection,
    listReservations: deps.listReservations,
    listPendingProvisions: deps.listPendingProvisions,
    listPendingCleanups: deps.listPendingCleanups,
  });
  const reviewRuntime = createTelegramInactiveThreadCleanupReviewRuntime<TBinding>({
    ...deps,
    getProfileName: deps.getProfileName,
    listBindings: deps.listBindings,
    getProtection: deps.getProtection,
    listReservations: deps.listReservations,
    listPendingProvisions: deps.listPendingProvisions,
    listPendingCleanups: deps.listPendingCleanups,
    getWorkStore,
    runWorkspaceOperation: deps.runWorkspaceOperation,
  });
  const permitRuntime = createTelegramThreadCleanupPermitRuntime({
    ledger: {
      read: () => deps.getAdmissionLedger()?.read() ?? {},
      acquireThreadCleanupFence(input) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.acquireThreadCleanupFence(input);
      },
      adoptThreadCleanupFence(fence, replacement) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.adoptThreadCleanupFence(fence, replacement);
      },
      issueThreadCleanupDeletionPermit(fence) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.issueThreadCleanupDeletionPermit(fence);
      },
      confirmThreadCleanupAbsence(fence) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.confirmThreadCleanupAbsence(fence);
      },
      releaseUnissuedThreadCleanupFence(fence) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.releaseUnissuedThreadCleanupFence(fence);
      },
      releaseFailedThreadCleanupFence(fence) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.releaseFailedThreadCleanupFence(fence);
      },
      completeThreadCleanupFence(fence) {
        const ledger = deps.getAdmissionLedger();
        if (!ledger) throw new Error("Telegram Thread cleanup requires workspace admission.");
        return ledger.completeThreadCleanupFence(fence);
      },
    },
    getLeaderEpoch: deps.getLeaderEpoch,
    getProfileName: deps.getProfileName,
    getOwner: deps.getOwner,
    canAdoptFence: (fence) => deps.canAdoptFence(fence.owner),
    async revalidateUnderFence(candidate) {
      const fresh = planTelegramInactiveThreadCleanup(captureEvidence())
        .find((entry) => entry.bindingKey === candidate.bindingKey);
      return (
        !!fresh &&
        fresh.bindingUpdatedAtMs === candidate.bindingUpdatedAtMs &&
        fresh.target.chatId === candidate.target.chatId &&
        fresh.target.threadId === candidate.target.threadId
      );
    },
  });
  return {
    review: reviewRuntime.review,
    async deleteEligible(options) {
      const candidates = planTelegramInactiveThreadCleanup({
        ...captureEvidence(),
        ...(options?.inactiveBeforeMs !== undefined
          ? { inactiveBeforeMs: options.inactiveBeforeMs }
          : {}),
      });
      let deleted = 0;
      let blocked = 0;
      for (const candidate of candidates) {
        try {
          await deps.deleteTopic(candidate.target);
        } catch (error) {
          if (!isTelegramTopicTargetStaleError(error)) {
            blocked += 1;
            deps.recordEvent?.("telegram", "Inactive Thread deletion failed", {
              phase: "thread-cleanup-delete",
              threadId: candidate.target.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          // The topic is already gone server-side, which is exactly the state a client-side
          // ghost tab represents; clear the local record instead of failing forever.
          deps.recordEvent?.("telegram", "Inactive Thread was already absent", {
            phase: "thread-cleanup-delete",
            threadId: candidate.target.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        deleted += 1;
        try {
          await deps.markStaleByTarget(candidate);
          const committed = await deps.commitInactiveWorkspaceCleanup(
            candidate,
            () => true,
          );
          if (!committed) {
            deps.recordEvent?.("telegram", "Inactive Thread binding stayed after deletion", {
              phase: "thread-cleanup-commit",
              threadId: candidate.target.threadId,
            });
          }
        } catch (error) {
          deps.recordEvent?.("telegram", "Inactive Thread cleanup commit failed", {
            phase: "thread-cleanup-commit",
            threadId: candidate.target.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { deleted, blocked };
    },
    sweepStaleCleanupFence() {
      const path = deps.resolveAdmissionPath?.();
      if (!path) return { cleared: false };
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        return { cleared: false };
      }
      const fence = parsed.fence as { destructiveKind?: unknown } | undefined;
      if (!fence || fence.destructiveKind !== "manual-thread-cleanup") {
        return { cleared: false };
      }
      // A fence this process cannot even observe still blocks every profile admission, so
      // clear it explicitly and keep a backup instead of leaving the daemon unable to start.
      const backupPath = `${path}.stale-fence-${Date.now()}.bak`;
      try {
        writeFileSync(backupPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
        delete parsed.fence;
        writeFileSync(path, JSON.stringify(parsed), { mode: 0o600 });
      } catch (error) {
        deps.recordEvent?.("telegram", "Stale cleanup fence sweep failed", {
          phase: "thread-cleanup-fence-sweep",
          error: error instanceof Error ? error.message : String(error),
        });
        return { cleared: false };
      }
      deps.recordEvent?.("telegram", "Stale cleanup fence cleared at startup", {
        phase: "thread-cleanup-fence-sweep",
        backupPath,
      });
      return { cleared: true, backupPath };
    },
    async recoverUnresolvedFence(): Promise<{
      status: "none" | "recovered" | "blocked";
      reason?: string;
      sawLedger?: boolean;
      sawFence?: boolean;
    }> {
      const ledger = deps.getAdmissionLedger();
      if (!ledger) return { status: "none" as const, sawLedger: false };
      const existing = readStoredCleanupFence();
      if (!existing) return { status: "none" as const, sawLedger: true, sawFence: false };
      // The ledger is already scoped to the active profile and bot identity, so any
      // cleanup fence in it is ours; only a different destructive kind is not.
      if (
        (existing.destructiveKind ?? "pressure-retirement") !== "manual-thread-cleanup"
      ) {
        return { status: "none" as const };
      }
      // The ledger can also hold a journal-writer closure fence, which is not a
      // destructive retirement fence and is not ours to resolve.
      if (!("retirementIntentId" in existing)) return { status: "none" as const };
      let fence: TelegramThreadCleanupFence = existing;
      const owner = deps.getOwner();
      if (
        fence.owner.processId !== owner.processId ||
        fence.owner.processBirthId !== owner.processBirthId
      ) {
        if (!deps.canAdoptFence(fence.owner)) {
          return { status: "blocked" as const, reason: "fence-owner-alive" };
        }
        try {
          fence = ledger.adoptThreadCleanupFence(fence, {
            owner,
            leaderEpoch: deps.getLeaderEpoch() ?? fence.leaderEpoch,
          });
          // Adoption refreshes fence stamps, so every later ledger call must use the
          // stored object; a stale copy fails exact-fence validation.
          fence = readStoredCleanupFence() ?? fence;
        } catch (error) {
          return {
            status: "blocked" as const,
            reason: error instanceof Error ? error.message : "adopt-failed",
          };
        }
      }
      if (fence.phase === "fenced") return { status: "none" as const };
      const store = getWorkStore();
      const workSet = store.list().find((entry) => entry.operationId === fence.retirementIntentId);
      const candidate = workSet?.entries.find((entry) => entry.bindingKey === fence.bindingKey);
      try {
        if (fence.phase === "deletion-issued") {
          // Re-prove the target once: either the delete lands now, or the topic is already
          // gone. Both make absence confirmation truthful.
          try {
            await deps.deleteTopic(fence.target);
            if (candidate) await deps.markStaleByTarget(candidate);
          } catch (error) {
            // The deletion did not happen. Retrying `deleteForumTopic` later is
            // idempotent, while holding the fence blocks every profile admission —
            // including the leader's startup — so release it and report why.
            const stored = readStoredCleanupFence();
            const released =
              stored && stored.retirementIntentId === fence.retirementIntentId
                ? ledger.releaseFailedThreadCleanupFence(stored)
                : false;
            deps.recordEvent?.(
              "telegram",
              "Inactive Thread cleanup fence released after a failed deletion",
              {
                phase: "thread-cleanup-fence-release",
                threadId: fence.target.threadId,
                released,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return {
              status: released ? ("recovered" as const) : ("blocked" as const),
              reason: error instanceof Error ? error.message : "delete-failed",
            };
          }
        }
        const ready = ledger.confirmThreadCleanupAbsence(readStoredCleanupFence() ?? fence);
        const committed = candidate
          ? await deps.commitInactiveWorkspaceCleanup(candidate, () => true)
          : true;
        if (committed) ledger.completeThreadCleanupFence(ready);
        deps.recordEvent?.("telegram", "Inactive Thread cleanup fence recovered", {
          phase: "thread-cleanup-fence-recovery",
          threadId: fence.target.threadId,
          phaseBefore: existing.phase,
          committed,
        });
        return { status: "recovered" as const, reason: `deletion-${existing.phase}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.recordEvent?.("telegram", "Inactive Thread cleanup fence unresolved", {
          phase: "thread-cleanup-fence-recovery",
          threadId: fence.target.threadId,
          phaseBefore: existing.phase,
          error: message,
        });
        return { status: "blocked" as const, reason: message };
      }
    },
    survey(options) {
      const evidence = captureEvidence();
      // Eligible under full evidence (no age cutoff) and cleanable under it.
      const all = planTelegramInactiveThreadCleanup(evidence);
      const cleanable = planTelegramInactiveThreadCleanup({
        ...evidence,
        inactiveBeforeMs: options.inactiveBeforeMs,
      });
      const cleanableKeys = new Set(cleanable.map((entry) => entry.bindingKey));
      let tooYoung = 0;
      let blockedByEvidence = 0;
      let blockedByCompeting = 0;
      for (const binding of evidence.bindings) {
        if (typeof binding.inactiveSinceMs !== "number") continue;
        // Probe one binding at a time with proven-clear protection and no competitors: if
        // that cannot produce a candidate, the binding itself is not dormant-eligible.
        const both = planTelegramInactiveThreadCleanup({
          ...evidence,
          bindings: [binding],
          protection: [
            {
              bindingKey: binding.bindingKey,
              target: binding.target,
              liveOwner: "clear" as const,
              acceptedWork: "clear" as const,
              deliveryAuthority: "clear" as const,
            },
          ],
          reservedTargets: [],
          provisioningTargets: [],
          cleanupTargets: [],
        });
        if (both.length === 0) continue;
        if (cleanableKeys.has(binding.bindingKey)) continue;
        if (all.some((entry) => entry.bindingKey === binding.bindingKey)) {
          tooYoung += 1;
          continue;
        }
        // Real protection with no competitor still yields nothing, so evidence blocks it.
        const clearedOnly = planTelegramInactiveThreadCleanup({
          ...evidence,
          reservedTargets: [],
          provisioningTargets: [],
          cleanupTargets: [],
        });
        if (!clearedOnly.some((entry) => entry.bindingKey === binding.bindingKey)) {
          blockedByEvidence += 1;
        } else {
          blockedByCompeting += 1;
        }
      }
      return Promise.resolve({
        cleanable: cleanable.length,
        tooYoung,
        blockedByEvidence,
        blockedByCompeting,
      });
    },
    deleteReviewed(operationId) {
      return cleanReviewedInactiveThreads({
        operationId,
        store: getWorkStore(),
        permitRuntime,
        resolveFullBinding: deps.resolveFullBinding,
        async deleteWithPermit(permit, candidate) {
          if (
            permit.destructiveKind !== "manual-thread-cleanup" ||
            permit.bindingKey !== candidate.bindingKey ||
            permit.slot !== candidate.slot ||
            permit.target.chatId !== candidate.target.chatId ||
            permit.target.threadId !== candidate.target.threadId
          ) {
            throw new Error("Telegram Thread cleanup received a mismatched deletion permit.");
          }
          try {
            await deps.deleteTopic(candidate.target);
          } catch (error) {
            // The coordinator keeps an ambiguous outcome and never replays it, so this is
            // the only place the real Telegram failure becomes visible.
            deps.recordEvent?.("telegram", "Inactive Thread deletion failed", {
              phase: "thread-cleanup-delete",
              threadId: candidate.target.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          await deps.markStaleByTarget(candidate);
        },
        commitBinding(candidate) {
          const profileName = deps.getProfileName();
          const leaderEpoch = deps.getLeaderEpoch();
          return deps.commitInactiveWorkspaceCleanup(candidate, () =>
            leaderEpoch !== undefined &&
            deps.getLeaderEpoch() === leaderEpoch &&
            deps.getProfileName() === profileName);
        },
      });
    },
  };
}

/**
 * Operator-visible summary of one unattended cleanup pass. Returns undefined when the
 * pass settled nothing, so the janitor stays silent instead of posting noise.
 */
export function formatTelegramUnattendedCleanupNotice(
  result: TelegramInactiveThreadCleanupResult,
): string | undefined {
  const { deleted, outcomeUnknown, blocked } = result;
  if (deleted > 0) {
    const leftover = outcomeUnknown + blocked;
    return leftover > 0
      ? `🧹 <b>Unattended cleanup deleted ${deleted} inactive tab(s); ${leftover} stayed blocked.</b>`
      : `🧹 <b>Unattended cleanup deleted ${deleted} inactive tab(s).</b>`;
  }
  if (outcomeUnknown > 0) {
    return `⚠️ <b>Unattended cleanup deleted nothing; ${outcomeUnknown} deletion outcome is unknown.</b>`;
  }
  if (blocked > 0) {
    return `⚠️ <b>Unattended cleanup deleted nothing; ${blocked} candidate(s) stayed blocked.</b>`;
  }
  return undefined;
}
