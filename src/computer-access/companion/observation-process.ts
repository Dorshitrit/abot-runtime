import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { PassiveCollectionState, PassiveCollectorEvent } from "../../shared/passive-observation.js";
import { ObservationFilter } from "./observation-filter.js";
import { LINUX_OBSERVATION_SCRIPT } from "./observation-linux.js";
import { MACOS_OBSERVATION_SCRIPT } from "./observation-macos.js";
import { WINDOWS_OBSERVATION_SCRIPT } from "./observation-windows.js";
import { OBSERVATION_WIRE_LIMIT } from "./observation-protocol.js";

export type DesktopCollector = { close(): void };

function isCollectorFailureStatus(state: PassiveCollectionState): boolean {
  return ["unavailable", "permission_required", "failed"].includes(state);
}

export function desktopCollectorCommand(
  platform: string,
): { file: string; args: string[]; input?: string } | undefined {
  if (platform === "win32")
    return {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_OBSERVATION_SCRIPT, "utf16le").toString("base64"),
      ],
    };
  if (platform === "darwin")
    return {
      file: "/usr/bin/swift",
      args: ["-"],
      input: MACOS_OBSERVATION_SCRIPT,
    };
  if (platform === "linux")
    return { file: "python3", args: ["-u", "-c", LINUX_OBSERVATION_SCRIPT] };
  return undefined;
}

export function startDesktopCollector(options: {
  excludedApplications: readonly string[];
  onEvent(event: PassiveCollectorEvent): void;
  platform?: string;
  spawnProcess?: typeof spawn;
}): DesktopCollector {
  const command = desktopCollectorCommand(options.platform ?? process.platform);
  let child: ChildProcess | undefined;
  let closed = false;
  let received = Buffer.alloc(0);
  let terminalStatus = false;
  const filter = new ObservationFilter(options.excludedApplications);
  const close = () => {
    closed = true;
    if (!child?.pid) return;
    // POSIX language launchers can spawn an interpreter; stop the entire owned process group.
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
      return;
    }
    child.kill();
  };
  if (!command) {
    options.onEvent({
      type: "status",
      state: "unavailable",
      reason: "platform_unsupported",
    });
    return { close };
  }
  if (process.platform === "darwin") {
    try {
      const developerDirectory = execFileSync("/usr/bin/xcode-select", ["-p"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!existsSync(developerDirectory)) throw new Error("swift_unavailable");
    } catch {
      options.onEvent({
        type: "status",
        state: "unavailable",
        reason: "macos_swift_tools_unavailable",
      });
      return { close };
    }
  }
  options.onEvent({ type: "status", state: "starting" });
  child = (options.spawnProcess ?? spawn)(command.file, command.args, {
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ABOT_OBSERVATION_EXCLUSIONS: JSON.stringify(options.excludedApplications),
    },
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(command.input);
  // Compiler/dependency diagnostics can contain local paths. Never forward them into model or general logs.
  child.stderr?.resume();
  child.stdout?.on("data", (chunk: Buffer) => {
    if (closed) return;
    received = Buffer.concat([received, chunk]);
    if (received.length > OBSERVATION_WIRE_LIMIT * 2) {
      options.onEvent({
        type: "status",
        state: "failed",
        reason: "collector_output_limit",
      });
      close();
      return;
    }
    let boundary = received.indexOf(10);
    while (boundary >= 0) {
      try {
        const event = filter.accept(
          JSON.parse(received.subarray(0, boundary).toString()),
        );
        if (event?.type === "status")
          terminalStatus = isCollectorFailureStatus(event.state);
        if (event) options.onEvent(event);
      } catch {
        options.onEvent({
          type: "status",
          state: "failed",
          reason: "collector_protocol_invalid",
        });
        close();
        return;
      }
      received = received.subarray(boundary + 1);
      boundary = received.indexOf(10);
    }
  });
  child.once("error", () => {
    if (closed) return;
    options.onEvent({
      type: "status",
      state: "unavailable",
      reason: "collector_dependency_unavailable",
    });
    close();
  });
  child.once("exit", (code) => {
    if (closed) return;
    if (!terminalStatus)
      options.onEvent({
        type: "status",
        state: "unavailable",
        reason: code === 0 ? "collector_stopped" : "collector_start_failed",
      });
    close();
  });
  return { close };
}
