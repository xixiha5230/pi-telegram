/**
 * Regression tests for the daemon autostart service installer
 * Covers launchd/systemd rendering, path resolution, explicit install/uninstall, and
 * fail-closed behavior on unsupported platforms and load failures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramDaemonServiceInstaller,
  getTelegramDaemonServiceLabel,
  renderTelegramDaemonLaunchdPlist,
  renderTelegramDaemonService,
  renderTelegramDaemonSystemdUnit,
  resolveTelegramDaemonServicePath,
  type TelegramDaemonServiceInstallerDeps,
} from "../lib/daemon-service.ts";

const SPEC = {
  nodePath: "/usr/bin/node",
  daemonBinPath: "/pkg/bin/pi-telegram-daemon.mjs",
  cwd: "/repo",
  logPath: "/agent/tmp/telegram/daemon.log",
};

test("Service labels and paths are platform-specific and fail closed elsewhere", () => {
  assert.equal(getTelegramDaemonServiceLabel("darwin"), "com.pi.telegram-daemon");
  assert.equal(getTelegramDaemonServiceLabel("linux"), "pi-telegram-daemon");
  assert.equal(getTelegramDaemonServiceLabel("win32"), undefined);
  assert.equal(
    resolveTelegramDaemonServicePath({ platform: "darwin", homeDir: "/home/x" }),
    "/home/x/Library/LaunchAgents/com.pi.telegram-daemon.plist",
  );
  assert.equal(
    resolveTelegramDaemonServicePath({ platform: "linux", homeDir: "/home/x" }),
    "/home/x/.config/systemd/user/pi-telegram-daemon.service",
  );
  assert.equal(
    resolveTelegramDaemonServicePath({ platform: "win32", homeDir: "/home/x" }),
    undefined,
  );
  assert.equal(renderTelegramDaemonService({ ...SPEC, platform: "win32" }), undefined);
});

test("launchd plist keeps the daemon alive and escapes values", () => {
  const plist = renderTelegramDaemonLaunchdPlist({
    ...SPEC,
    platform: "darwin",
    cwd: "/repo <&>",
    agentDir: "/agent dir",
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/u);
  assert.match(plist, /<string>\/repo &lt;&amp;&gt;<\/string>/u);
  assert.match(plist, /<key>PI_CODING_AGENT_DIR<\/key><string>\/agent dir<\/string>/u);
  assert.match(plist, /--cwd<\/string>/u);
});

test("systemd unit restarts on failure and quotes the exec line", () => {
  const unit = renderTelegramDaemonSystemdUnit({
    ...SPEC,
    platform: "linux",
    cwd: "/repo dir",
    agentDir: "/agent",
  });
  assert.match(unit, /Restart=always/u);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/pkg\/bin\/pi-telegram-daemon\.mjs" --cwd "\/repo dir"/u);
  assert.match(unit, /Environment=PI_CODING_AGENT_DIR=\/agent/u);
  assert.match(unit, /WantedBy=default\.target/u);
});

function installer(overrides: Partial<TelegramDaemonServiceInstallerDeps> = {}) {
  const written: Array<{ path: string; content: string }> = [];
  const removed: string[] = [];
  const runs: Array<{ command: string; args: readonly string[] }> = [];
  let exists = false;
  const deps: TelegramDaemonServiceInstallerDeps = {
    platform: "darwin",
    homeDir: "/home/x",
    getUid: () => 501,
    writeFile: (path, content) => {
      written.push({ path, content });
      exists = true;
    },
    removeFile: (path) => {
      removed.push(path);
      exists = false;
    },
    exists: () => exists,
    run: (command, args) => {
      runs.push({ command, args });
      return { ok: true };
    },
    ...overrides,
  };
  return { installer: createTelegramDaemonServiceInstaller(deps), written, removed, runs };
}

test("install writes the unit and loads it; status reflects it", async () => {
  const s = installer();
  assert.deepEqual(s.installer.status(), { installed: false });
  const result = await s.installer.install(SPEC);
  assert.equal(result.ok, true);
  assert.match(result.message, /Installed autostart/u);
  assert.equal(s.written.length, 1);
  assert.equal(s.written[0]?.path, "/home/x/Library/LaunchAgents/com.pi.telegram-daemon.plist");
  assert.deepEqual(s.runs, [
    { command: "launchctl", args: ["bootout", "gui/501/com.pi.telegram-daemon"] },
    {
      command: "launchctl",
      args: ["bootstrap", "gui/501", "/home/x/Library/LaunchAgents/com.pi.telegram-daemon.plist"],
    },
  ]);
  assert.deepEqual(s.installer.status(), {
    installed: true,
    path: "/home/x/Library/LaunchAgents/com.pi.telegram-daemon.plist",
  });
});

test("install reports a load failure but leaves the unit for inspection", async () => {
  const s = installer({
    run: (command, args) =>
      command === "launchctl" && args[0] === "bootstrap"
        ? { ok: false, stderr: "boom" }
        : { ok: true },
  });
  const result = await s.installer.install(SPEC);
  assert.equal(result.ok, false);
  assert.match(result.message, /enabling it failed/u);
  assert.equal(s.written.length, 1);
});

test("uninstall disables and removes the unit", async () => {
  const s = installer();
  await s.installer.install(SPEC);
  const result = await s.installer.uninstall();
  assert.equal(result.ok, true);
  assert.match(result.message, /Removed autostart/u);
  assert.deepEqual(s.removed, ["/home/x/Library/LaunchAgents/com.pi.telegram-daemon.plist"]);
  assert.deepEqual(s.installer.status(), { installed: false });
});

test("unsupported platforms fail closed without writing anything", async () => {
  const s = installer({ platform: "win32" });
  assert.equal((await s.installer.install(SPEC)).ok, false);
  assert.equal((await s.installer.uninstall()).ok, false);
  assert.deepEqual(s.written, []);
  assert.deepEqual(s.removed, []);
});
