/**
 * Regression tests for managed-worker spawn environment
 * Covers Pi session-descriptor stripping and operator configuration preservation
 */

import assert from "node:assert/strict";
import test from "node:test";

import { telegramWorkerSpawnEnvironment } from "../lib/worker-process.ts";

test("Worker spawn environment drops the daemon's Pi session descriptors", () => {
  const env = telegramWorkerSpawnEnvironment({
    PI_SESSION_FILE: "/tmp/session.jsonl",
    PI_SESSION_ID: "abc",
    PI_PROVIDER: "ada",
    PI_MODEL: "deepseek-v4.1-flash",
    PI_REASONING_LEVEL: "medium",
    PI_CODING_AGENT: "true",
    PI_CODING_AGENT_DIR: "/tmp/agent",
    ADA_API_KEY: "key",
    PATH: "/usr/bin",
  });
  assert.equal(env.PI_SESSION_FILE, undefined);
  assert.equal(env.PI_SESSION_ID, undefined);
  assert.equal(env.PI_PROVIDER, undefined);
  assert.equal(env.PI_MODEL, undefined);
  assert.equal(env.PI_REASONING_LEVEL, undefined);
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/agent");
  assert.equal(env.ADA_API_KEY, "key");
  assert.equal(env.PATH, "/usr/bin");
});
