/**
 * Telegram daemon service installer
 * Zones: daemon control plane, process boundary
 * Owns rendering and installing the OS service that keeps the external daemon running
 * at login (macOS launchd, Linux systemd user unit). It is an explicit, reversible
 * operator action: nothing installs silently, and every path is reported. Windows is
 * reported as unsupported rather than guessed.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const LAUNCHD_LABEL = "com.pi.telegram-daemon";
const SYSTEMD_LABEL = "pi-telegram-daemon";

export interface TelegramDaemonServiceSpec {
  platform: NodeJS.Platform;
  nodePath: string;
  daemonBinPath: string;
  cwd: string;
  agentDir?: string;
  logPath: string;
}

/** Stable service label per platform, or undefined when unsupported. */
export function getTelegramDaemonServiceLabel(
  platform: NodeJS.Platform,
): string | undefined {
  if (platform === "darwin") return LAUNCHD_LABEL;
  if (platform === "linux") return SYSTEMD_LABEL;
  return undefined;
}

/** Absolute service file path, or undefined when unsupported. */
export function resolveTelegramDaemonServicePath(input: {
  platform: NodeJS.Platform;
  homeDir: string;
}): string | undefined {
  const label = getTelegramDaemonServiceLabel(input.platform);
  if (!label) return undefined;
  if (input.platform === "darwin") {
    return `${input.homeDir}/Library/LaunchAgents/${label}.plist`;
  }
  return `${input.homeDir}/.config/systemd/user/${label}.service`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function systemdEscape(value: string): string {
  // systemd ExecStart quoting: wrap in double quotes and escape inner quotes/backslashes.
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export function renderTelegramDaemonLaunchdPlist(
  spec: TelegramDaemonServiceSpec,
): string {
  const env = spec.agentDir
    ? `  <key>EnvironmentVariables</key><dict><key>PI_CODING_AGENT_DIR</key><string>${xmlEscape(spec.agentDir)}</string></dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.nodePath)}</string>
    <string>${xmlEscape(spec.daemonBinPath)}</string>
    <string>--cwd</string>
    <string>${xmlEscape(spec.cwd)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(spec.logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(spec.logPath)}</string>
${env}</dict>
</plist>
`;
}

export function renderTelegramDaemonSystemdUnit(
  spec: TelegramDaemonServiceSpec,
): string {
  const env = spec.agentDir
    ? `Environment=PI_CODING_AGENT_DIR=${spec.agentDir}\n`
    : "";
  return `[Unit]
Description=pi-telegram-daemon (external Telegram transport owner)
After=network-online.target

[Service]
ExecStart=${systemdEscape(spec.nodePath)} ${systemdEscape(spec.daemonBinPath)} --cwd ${systemdEscape(spec.cwd)}
Restart=always
RestartSec=3
${env}
[Install]
WantedBy=default.target
`;
}

/** Render the platform service file, or undefined when the platform is unsupported. */
export function renderTelegramDaemonService(
  spec: TelegramDaemonServiceSpec,
): string | undefined {
  if (spec.platform === "darwin") return renderTelegramDaemonLaunchdPlist(spec);
  if (spec.platform === "linux") return renderTelegramDaemonSystemdUnit(spec);
  return undefined;
}

export interface TelegramDaemonServiceInstallerDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  getUid: () => number;
  writeFile: (path: string, content: string, mode: number) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  run: (command: string, args: readonly string[]) => { ok: boolean; stderr?: string };
  recordEvent?: (message: string, details?: Record<string, unknown>) => void;
}

export interface TelegramDaemonServiceInstaller {
  status: () => { installed: boolean; path?: string };
  install: (
    spec: Omit<TelegramDaemonServiceSpec, "platform">,
  ) => Promise<{ ok: boolean; message: string }>;
  uninstall: () => Promise<{ ok: boolean; message: string }>;
}

export function createTelegramDaemonServiceInstaller(
  deps: TelegramDaemonServiceInstallerDeps,
): TelegramDaemonServiceInstaller {
  const label = getTelegramDaemonServiceLabel(deps.platform);
  const servicePath = resolveTelegramDaemonServicePath({
    platform: deps.platform,
    homeDir: deps.homeDir,
  });

  const reload = (): { ok: boolean; stderr?: string } => {
    if (deps.platform === "darwin") {
      const uid = deps.getUid();
      // bootout is idempotent enough for install; ignore its failure.
      deps.run("launchctl", ["bootout", `gui/${uid}/${label}`]);
      return deps.run("launchctl", ["bootstrap", `gui/${uid}`, servicePath!]);
    }
    if (deps.platform === "linux") {
      const reloadResult = deps.run("systemctl", ["--user", "daemon-reload"]);
      if (!reloadResult.ok) return reloadResult;
      return deps.run("systemctl", ["--user", "enable", "--now", `${label}.service`]);
    }
    return { ok: false, stderr: "unsupported platform" };
  };

  return {
    status: () =>
      servicePath && deps.exists(servicePath)
        ? { installed: true, path: servicePath }
        : { installed: false },
    async install(spec) {
      if (!label || !servicePath) {
        return {
          ok: false,
          message: `Autostart is not supported on ${deps.platform}.`,
        };
      }
      const content = renderTelegramDaemonService({
        ...spec,
        platform: deps.platform,
      });
      if (!content) {
        return { ok: false, message: `Autostart is not supported on ${deps.platform}.` };
      }
      try {
        deps.writeFile(servicePath, content, 0o644);
      } catch (error) {
        deps.recordEvent?.("Telegram daemon service write failed", {
          phase: "daemon-service-install",
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: `Could not write ${servicePath}.` };
      }
      const result = reload();
      if (!result.ok) {
        deps.recordEvent?.("Telegram daemon service load failed", {
          phase: "daemon-service-install",
          stderr: result.stderr,
        });
        return {
          ok: false,
          message: `Installed ${servicePath}, but enabling it failed.`,
        };
      }
      return { ok: true, message: `Installed autostart at ${servicePath}.` };
    },
    async uninstall() {
      if (!label || !servicePath) {
        return { ok: false, message: `Autostart is not supported on ${deps.platform}.` };
      }
      if (deps.platform === "darwin") {
        deps.run("launchctl", ["bootout", `gui/${deps.getUid()}/${label}`]);
      } else if (deps.platform === "linux") {
        deps.run("systemctl", ["--user", "disable", "--now", `${label}.service`]);
      }
      try {
        deps.removeFile(servicePath);
      } catch {
        /* best effort: the unit may already be gone */
      }
      return { ok: true, message: `Removed autostart (${servicePath}).` };
    },
  };
}

/** Production installer ports backed by the real filesystem and platform CLIs. */
export function createTelegramDaemonServiceInstallerPorts(input: {
  homeDir: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}): TelegramDaemonServiceInstallerDeps {
  return {
    platform: process.platform,
    homeDir: input.homeDir,
    getUid: () => process.getuid?.() ?? 0,
    writeFile: (path, content, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { encoding: "utf8", mode });
    },
    removeFile: (path) => {
      rmSync(path, { force: true });
    },
    exists: existsSync,
    run: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf8" });
      return {
        ok: result.status === 0,
        ...(result.stderr ? { stderr: String(result.stderr) } : {}),
      };
    },
    recordEvent: (message, details) =>
      input.recordRuntimeEvent?.("daemon", message, details),
  };
}
