/**
 * Regression tests for the Pi-leader worker roster
 * Covers leader/follower listing and daemon-only lifecycle refusal
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createPiLeaderWorkerControl } from "../lib/pi-worker-roster.ts";

function setup() {
  return createPiLeaderWorkerControl({
    getLockState: () => ({
      kind: "active-here",
      lock: {
        pid: 25547,
        cwd: "/repo/pi-telegram",
        instanceId: "25547:1000",
        runtimeGeneration: 1000,
      },
    }),
    listFollowers: () => [
      {
        instanceId: "999:2000",
        profileKey: "cwd:/repo/worker",
        cwd: "/repo/worker",
        sessionId: "session-b",
        pid: 999,
        processBirthId: "999:born",
        sessionGeneration: 2000,
        connectedAtMs: 1,
        lastHeartbeatMs: 2,
      },
    ],
    getSessionId: () => "session-leader",
  });
}

test("Pi leader roster lists itself and live followers", async () => {
  const control = setup();
  const result = await control.execute({ kind: "list" }, {
    target: { chatId: 1 },
    epoch: "pi-leader",
  });
  assert.equal(result.ok, true);
  assert.match(result.html, /25547:1000/u);
  assert.match(result.html, /999:2000/u);

  assert.match(result.html, /session-leader/u);
  assert.match(result.html, /· leader/u);
});

test("Pi leader roster refuses daemon-only lifecycle commands", async () => {
  const control = setup();
  const result = await control.execute({ kind: "start", spec: "plugins" }, {
    target: { chatId: 1 },
    epoch: "pi-leader",
  });
  assert.equal(result.ok, false);
  assert.match(result.html, /daemon-only/u);
});
