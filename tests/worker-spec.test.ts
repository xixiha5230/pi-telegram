/**
 * Regression tests for daemon worker launch specs
 * Covers root containment, cwd resolution, field validation, and launch planning
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  planTelegramWorkerLaunch,
  validateTelegramWorkerLaunchSpec,
  type TelegramWorkerLaunchSpec,
} from "../lib/worker-spec.ts";

const ports = {
  resolveRealPath: (path: string) => path.replace(/\/+$/u, ""),
  isDirectory: () => true,
};

const allowedRoots = ["/work"];

function validate(input: unknown) {
  return validateTelegramWorkerLaunchSpec(input, { allowedRoots, ports });
}

test("Worker spec validation accepts a constrained spec", () => {
  const result = validate({ name: "plugins", cwd: "/work/plugins" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.spec.cwd, "/work/plugins");
  assert.equal(result.spec.trust, "approve");
  assert.equal(result.spec.restart, "on-failure");
  assert.deepEqual(result.spec.args, []);
});

test("Worker spec validation rejects malformed names and cwds", () => {
  assert.deepEqual(validate(null), { ok: false, reason: "invalid-shape" });
  assert.deepEqual(validate({ name: "Bad Name", cwd: "/work/x" }), {
    ok: false,
    reason: "invalid-name",
  });
  assert.deepEqual(validate({ name: "ok", cwd: "relative" }), {
    ok: false,
    reason: "relative-cwd",
  });
  assert.deepEqual(validate({ name: "ok", cwd: "/elsewhere" }), {
    ok: false,
    reason: "cwd-outside-roots",
  });
});

test("Worker spec validation rejects a symlink escape after realpath resolution", () => {
  const result = validateTelegramWorkerLaunchSpec(
    { name: "escape", cwd: "/work/link" },
    {
      allowedRoots,
      ports: {
        resolveRealPath: (path) => (path === "/work/link" ? "/secret/target" : path),
        isDirectory: () => true,
      },
    },
  );
  assert.deepEqual(result, { ok: false, reason: "cwd-outside-roots" });
});

test("Worker spec validation rejects non-directory and invalid fields", () => {
  assert.deepEqual(
    validateTelegramWorkerLaunchSpec(
      { name: "ok", cwd: "/work/missing" },
      { allowedRoots, ports: { resolveRealPath: (p) => p, isDirectory: () => false } },
    ),
    { ok: false, reason: "cwd-not-directory" },
  );
  assert.equal(validate({ name: "ok", cwd: "/work/x", trust: "always" }).ok, false);
  assert.equal(validate({ name: "ok", cwd: "/work/x", restart: "always" }).ok, false);
  assert.equal(validate({ name: "ok", cwd: "/work/x", session: 3 }).ok, false);
  assert.equal(validate({ name: "ok", cwd: "/work/x", args: [1] }).ok, false);
  assert.equal(validate({ name: "ok", cwd: "/work/x", env: { "1bad": "x" } }).ok, false);
});

test("Worker launch planning builds an explicit rpc invocation", () => {
  const validated = validate({ name: "plugins", cwd: "/work/plugins" });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const spec: TelegramWorkerLaunchSpec = validated.spec;
  const plan = planTelegramWorkerLaunch(spec, { executable: "pi" });
  assert.equal(plan.command, "pi");
  assert.deepEqual(plan.args, ["--mode", "rpc", "--approve"]);
  assert.equal(plan.cwd, "/work/plugins");
  // The daemon relays Telegram for the worker, so it never receives bus credentials;
  // it declares exactly one manual-follower identity instead.
  assert.equal(plan.env.PI_TELEGRAM_DAEMON, undefined);
  assert.equal(plan.env.PI_TELEGRAM_WORKER_TOKEN, undefined);
  assert.equal(plan.env.PI_TELEGRAM_FOLLOWER_OWNER_ID, "worker:plugins");
  // A managed worker must never race the daemon for transport ownership.
  assert.equal(plan.env.PI_TELEGRAM_DAEMON_WORKER, "1");
  const other = validate({ name: "docs", cwd: "/work/docs" });
  assert.equal(other.ok, true);
  if (other.ok) {
    assert.equal(
      planTelegramWorkerLaunch(other.spec, { executable: "pi" }).env
        .PI_TELEGRAM_FOLLOWER_OWNER_ID,
      "worker:docs",
    );
  }
  // The daemon provisions only the bot identity digest; the worker never gets the token.
  const digest = "a".repeat(64);
  const identified = planTelegramWorkerLaunch(spec, {
    executable: "pi",
    identityEnv: {
      PI_TELEGRAM_WORKER_BOT_TOKEN_SHA256: digest,
      PI_TELEGRAM_WORKER_BOT_ID: "42",
    },
  });
  assert.equal(identified.env.PI_TELEGRAM_WORKER_BOT_TOKEN_SHA256, digest);
  assert.equal(identified.env.PI_TELEGRAM_WORKER_BOT_ID, "42");
  assert.equal(identified.env.PI_TELEGRAM_DAEMON_WORKER, "1");
  assert.equal(identified.env.PI_TELEGRAM_FOLLOWER_OWNER_ID, "worker:plugins");
});
