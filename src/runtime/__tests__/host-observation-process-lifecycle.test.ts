import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { startDesktopCollector } from "../../computer-access/companion/observation-process.js";
import type { PassiveCollectionState, PassiveCollectorEvent } from "../../shared/passive-observation.js";

// Prerequisite detection never launches a real executable, including on Mac CI.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => process.cwd()),
}));

function collector() {
  // No PID, so shutdown cannot signal a real operating-system process.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const spawnProcess = vi.fn<typeof spawn>().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const events: PassiveCollectorEvent[] = [];
  const running = startDesktopCollector({
    platform: "darwin", excludedApplications: [], spawnProcess: spawnProcess as unknown as typeof spawn, onEvent: (event) => events.push(event),
  });
  const status = (state: PassiveCollectionState, reason?: string) => {
    child.stdout.write(JSON.stringify({ type: "status", state, reason }) + "\n");
  };
  return { child, spawnProcess, events, running, status };
}

test.each([
  [0, "collector_stopped"],
  [1, "collector_start_failed"],
] as const)("permission recovery exposes a later exit with code %s", (code, reason) => {
  const f = collector();
  try {
    f.status("permission_required", "macos_accessibility_permission_required");
    f.status("partial", "ax_application_coverage");
    f.child.emit("exit", code);
    expect(f.events).toEqual([
      { type: "status", state: "starting" },
      { type: "status", state: "permission_required", reason: "macos_accessibility_permission_required" },
      { type: "status", state: "partial", reason: "ax_application_coverage" },
      { type: "status", state: "unavailable", reason },
    ]);
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  } finally {
    f.running.close();
  }
});

test.each([
  ["permission_required", "macos_accessibility_permission_required"],
  ["permission_required", "macos_accessibility_permission_timeout"],
  ["permission_required", "macos_accessibility_permission_revoked"],
  ["unavailable", "collector_dependency_unavailable"],
  ["failed", "collector_output_limit"],
] as const)("exit retains the latest %s reason %s", (state, reason) => {
  const f = collector();
  try {
    f.status("permission_required", "macos_accessibility_permission_required");
    f.status(state, reason);
    const beforeExit = [...f.events];
    f.child.emit("exit", 0);
    expect(f.events).toEqual(beforeExit);
    expect(f.events.at(-1)).toEqual({ type: "status", state, reason });
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  } finally {
    f.running.close();
  }
});
