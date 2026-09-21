/**
 * Session and project navigation
 * Zones: operator commands, pi agent sdk boundary
 * Owns cross-project session discovery, project grouping, and interactive session switch flows.
 */

import {
  SessionManager,
  type ExtensionCommandContext,
  type SessionInfo,
} from "./pi.ts";

export interface TelegramProjectSessionSummary {
  path: string;
  id: string;
  name?: string;
  cwd: string;
  modifiedMs: number;
  messageCount: number;
  firstMessage: string;
}

export interface TelegramSessionChoice {
  index: number;
  path: string;
  label: string;
  shortLabel: string;
}

export interface TelegramProjectChoice {
  index: number;
  cwd: string;
  sessionIndexes: number[];
}

export interface TelegramSessionSurface {
  sessions: TelegramSessionChoice[];
  projects: TelegramProjectChoice[];
}

const telegramSessionSurfacesByTarget = new Map<
  string,
  TelegramSessionSurface
>();

export function rememberTelegramSessionSurface(
  targetKey: string,
  sessions: readonly TelegramProjectSessionSummary[],
): TelegramSessionSurface {
  const choices: TelegramSessionChoice[] = sessions.map((session, index) => {
    const title =
      session.name ?? truncate(session.firstMessage || "(empty session)", 32);
    return {
      index: index + 1,
      path: session.path,
      label: formatSessionChoice(session, index),
      shortLabel: `${index + 1}. ${title}`,
    };
  });
  const groups = new Map<string, number[]>();
  for (const choice of choices) {
    const session = sessions[choice.index - 1];
    if (!session) continue;
    const key = session.cwd.length > 0 ? session.cwd : UNKNOWN_CWD_LABEL;
    const bucket = groups.get(key);
    if (bucket) bucket.push(choice.index);
    else groups.set(key, [choice.index]);
  }
  const projects: TelegramProjectChoice[] = [...groups.entries()].map(
    ([cwd, sessionIndexes], index) => ({
      index: index + 1,
      cwd,
      sessionIndexes,
    }),
  );
  const surface: TelegramSessionSurface = { sessions: choices, projects };
  if (choices.length === 0) telegramSessionSurfacesByTarget.delete(targetKey);
  else telegramSessionSurfacesByTarget.set(targetKey, surface);
  return surface;
}

export function getTelegramSessionSurface(
  targetKey: string,
): TelegramSessionSurface | undefined {
  return telegramSessionSurfacesByTarget.get(targetKey);
}

export function resolveTelegramSessionChoice(
  targetKey: string,
  selector: string,
): TelegramSessionChoice | undefined {
  const parsed = Number.parseInt(selector.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  const surface = telegramSessionSurfacesByTarget.get(targetKey);
  return surface ? surface.sessions[parsed - 1] : undefined;
}

export function resolveTelegramProjectChoice(
  targetKey: string,
  selector: string,
): TelegramProjectChoice | undefined {
  const parsed = Number.parseInt(selector.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  const surface = telegramSessionSurfacesByTarget.get(targetKey);
  return surface ? surface.projects[parsed - 1] : undefined;
}

export function formatTelegramPathLabel(cwd: string): string {
  const home = process.env.HOME;
  const shortened =
    home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const max = 56;
  if (shortened.length <= max) return shortened;
  const head = shortened.slice(0, 18);
  const tail = shortened.slice(-(max - 19));
  return `${head}…${tail}`;
}

export function formatTelegramSessionList(
  sessions: readonly TelegramProjectSessionSummary[],
): string {
  return sessions
    .map((session, index) => {
      const title =
        session.name ?? truncate(session.firstMessage || "(empty session)");
      const project = session.cwd.length > 0 ? session.cwd : UNKNOWN_CWD_LABEL;
      return `${index + 1}. ${escapeTelegramHtml(title)}\n    ${escapeTelegramHtml(project)} · ${session.messageCount} msgs · ${formatRelativeTime(session.modifiedMs)}`;
    })
    .join("\n");
}


export interface TelegramProjectSummary {
  cwd: string;
  sessionCount: number;
  latestModifiedMs: number;
  sessions: TelegramProjectSessionSummary[];
}

const UNKNOWN_CWD_LABEL = "(unknown directory)";

function summarizeSession(info: SessionInfo): TelegramProjectSessionSummary {
  return {
    path: info.path,
    id: info.id,
    ...(info.name ? { name: info.name } : {}),
    cwd: info.cwd,
    modifiedMs: info.modified.getTime(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
  };
}

export function groupTelegramSessionsByProject(
  sessions: readonly TelegramProjectSessionSummary[],
): TelegramProjectSummary[] {
  const groups = new Map<string, TelegramProjectSessionSummary[]>();
  for (const session of sessions) {
    const key = session.cwd.length > 0 ? session.cwd : UNKNOWN_CWD_LABEL;
    const bucket = groups.get(key);
    if (bucket) bucket.push(session);
    else groups.set(key, [session]);
  }
  const projects: TelegramProjectSummary[] = [];
  for (const [cwd, bucket] of groups) {
    const ordered = [...bucket].sort((a, b) => b.modifiedMs - a.modifiedMs);
    const latest = ordered[0];
    projects.push({
      cwd,
      sessionCount: ordered.length,
      latestModifiedMs: latest ? latest.modifiedMs : 0,
      sessions: ordered,
    });
  }
  return projects.sort((a, b) => b.latestModifiedMs - a.latestModifiedMs);
}

export async function listTelegramProjects(): Promise<TelegramProjectSummary[]> {
  const infos = await SessionManager.listAll();
  return groupTelegramSessionsByProject(infos.map(summarizeSession));
}

export async function listTelegramProjectSessions(
  cwd: string,
): Promise<TelegramProjectSessionSummary[]> {
  const infos = await SessionManager.list(cwd);
  return infos.map(summarizeSession).sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export async function listAllTelegramSessions(): Promise<
  TelegramProjectSessionSummary[]
> {
  const infos = await SessionManager.listAll();
  return infos.map(summarizeSession).sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export function formatRelativeTime(ms: number, nowMs = Date.now()): string {
  const delta = nowMs - ms;
  if (!Number.isFinite(delta) || delta < 0) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function truncate(text: string, max = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSessionChoice(
  session: TelegramProjectSessionSummary,
  index: number,
): string {
  const title = session.name ?? truncate(session.firstMessage || "(empty session)");
  return `${index + 1}. ${title} · ${session.messageCount} msgs · ${formatRelativeTime(session.modifiedMs)}`;
}

function formatProjectChoice(
  project: TelegramProjectSummary,
  index: number,
): string {
  return `${index + 1}. ${project.cwd} · ${project.sessionCount} sessions · ${formatRelativeTime(project.latestModifiedMs)}`;
}

export async function switchTelegramSession(
  ctx: ExtensionCommandContext,
  path: string,
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify(
      "Wait for the current run to finish before switching sessions.",
      "warning",
    );
    return;
  }
  let result: { cancelled: boolean };
  try {
    result = await ctx.switchSession(path, {
      withSession: async (nextCtx) => {
        nextCtx.ui.notify(`Switched to session ${path}`, "info");
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Session switch failed: ${detail}`, "error");
    return;
  }
  if (result.cancelled) {
    ctx.ui.notify("Session switch was cancelled.", "warning");
  }
}

async function pickSession(
  ctx: ExtensionCommandContext,
  sessions: readonly TelegramProjectSessionSummary[],
  title: string,
): Promise<void> {
  if (sessions.length === 0) {
    ctx.ui.notify(`${title}: no sessions found.`, "info");
    return;
  }
  const byLabel = new Map<string, TelegramProjectSessionSummary>();
  const labels = sessions.map((session, index) => {
    const label = formatSessionChoice(session, index);
    byLabel.set(label, session);
    return label;
  });
  const choice = await ctx.ui.select(title, labels);
  if (!choice) return;
  const session = byLabel.get(choice);
  if (!session) return;
  await switchTelegramSession(ctx, session.path);
}

export async function runTelegramProjectsCommand(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const projects = await listTelegramProjects();
  if (projects.length === 0) {
    ctx.ui.notify("No Pi sessions found.", "info");
    return;
  }
  const byLabel = new Map<string, TelegramProjectSummary>();
  const labels = projects.map((project, index) => {
    const label = formatProjectChoice(project, index);
    byLabel.set(label, project);
    return label;
  });
  const choice = await ctx.ui.select(
    "Pi projects (working directories)",
    labels,
  );
  if (!choice) return;
  const project = byLabel.get(choice);
  if (!project) return;
  await pickSession(ctx, project.sessions, `Sessions in ${project.cwd}`);
}

export async function runTelegramSessionsCommand(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const sessions = await listTelegramProjectSessions(ctx.cwd);
  await pickSession(ctx, sessions, `Sessions in ${ctx.cwd}`);
}

export async function runTelegramOpenCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const target = args.trim();
  if (target.length === 0) {
    ctx.ui.notify("Usage: /open <session-path|session-id>", "warning");
    return;
  }
  if (target.endsWith(".jsonl")) {
    await switchTelegramSession(ctx, target);
    return;
  }
  const [all, current] = await Promise.all([
    SessionManager.listAll(),
    SessionManager.list(ctx.cwd),
  ]);
  const match = [...current, ...all].find((info) => info.id === target);
  if (!match) {
    ctx.ui.notify(`No session found for id ${target}.`, "error");
    return;
  }
  await switchTelegramSession(ctx, match.path);
}
