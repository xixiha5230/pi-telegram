/**
 * Regression tests for session/project navigation helpers
 * Covers grouping, surface indexing, choice resolution, and path labels
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRelativeTime,
  formatTelegramPathLabel,
  getTelegramSessionSurface,
  groupTelegramSessionsByProject,
  rememberTelegramSessionSurface,
  resolveTelegramProjectChoice,
  resolveTelegramSessionChoice,
  type TelegramProjectSessionSummary,
} from "../lib/sessions.ts";

function session(
  overrides: Partial<TelegramProjectSessionSummary> &
    Pick<TelegramProjectSessionSummary, "cwd" | "modifiedMs">,
): TelegramProjectSessionSummary {
  return {
    path: overrides.path ?? `/sessions/${overrides.cwd}/${overrides.modifiedMs}.jsonl`,
    id: overrides.id ?? `id-${overrides.modifiedMs}`,
    cwd: overrides.cwd,
    modifiedMs: overrides.modifiedMs,
    messageCount: overrides.messageCount ?? 1,
    firstMessage: overrides.firstMessage ?? "hello",
    ...(overrides.name ? { name: overrides.name } : {}),
  };
}

test("formatRelativeTime buckets recent and older timestamps", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelativeTime(now - 5_000, now), "just now");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(formatRelativeTime(now + 10_000, now), "just now");
});

test("groupTelegramSessionsByProject groups and sorts by recency", () => {
  const base = 1_000_000_000_000;
  const groups = groupTelegramSessionsByProject([
    session({ cwd: "/a", modifiedMs: base - 1_000, firstMessage: "a-new" }),
    session({ cwd: "/b", modifiedMs: base - 5_000, firstMessage: "b" }),
    session({ cwd: "/a", modifiedMs: base - 3_000, firstMessage: "a-old" }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.cwd, "/a");
  assert.equal(groups[0]?.sessionCount, 2);
  assert.deepEqual(
    groups[0]?.sessions.map((entry) => entry.firstMessage),
    ["a-new", "a-old"],
  );
  assert.equal(groups[1]?.cwd, "/b");
});

test("session surface indexes sessions and projects by target", () => {
  const base = 1_000_000_000_000;
  const sessions = [
    session({ cwd: "/a", modifiedMs: base - 1_000, firstMessage: "a-new" }),
    session({ cwd: "/b", modifiedMs: base - 2_000, firstMessage: "b" }),
    session({ cwd: "/a", modifiedMs: base - 3_000, firstMessage: "a-old" }),
  ];
  const surface = rememberTelegramSessionSurface("surface-test", sessions);
  assert.equal(surface.sessions.length, 3);
  assert.equal(surface.projects.length, 2);
  assert.deepEqual(surface.projects[0]?.sessionIndexes, [1, 3]);
  assert.equal(surface.projects[0]?.cwd, "/a");
  assert.deepEqual(surface.projects[1]?.sessionIndexes, [2]);
  assert.equal(getTelegramSessionSurface("surface-test"), surface);
  assert.equal(
    resolveTelegramSessionChoice("surface-test", "3")?.path,
    sessions[2]?.path,
  );
  assert.equal(
    resolveTelegramProjectChoice("surface-test", "1")?.cwd,
    "/a",
  );
  assert.equal(resolveTelegramSessionChoice("surface-test", "0"), undefined);
  assert.equal(resolveTelegramProjectChoice("surface-test", "9"), undefined);
  assert.equal(getTelegramSessionSurface("missing-target"), undefined);
});

test("formatTelegramPathLabel shortens the home prefix", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = "/Users/tester";
  try {
    assert.equal(
      formatTelegramPathLabel("/Users/tester/projects/pi-plugins"),
      "~/projects/pi-plugins",
    );
    const long = `/Users/tester/projects/${"x".repeat(120)}/tail-project`;
    const label = formatTelegramPathLabel(long);
    assert.ok(label.length <= 56);
    assert.ok(label.startsWith("~/projects/"));
    assert.ok(label.endsWith("tail-project"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
