import { execFileSync, spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { MACOS_OBSERVATION_PERMISSION_SCRIPT } from "../../computer-access/companion/observation-macos-permission.js";
import { MACOS_OBSERVATION_SCRIPT } from "../../computer-access/companion/observation-macos.js";
import { desktopCollectorCommand } from "../../computer-access/companion/observation-process.js";

test("the Mac collector includes the independently exercised permission gate", () => {
  const command = desktopCollectorCommand("darwin");
  expect(command?.input).toBe(MACOS_OBSERVATION_SCRIPT);
  expect(command?.input).toContain(MACOS_OBSERVATION_PERMISSION_SCRIPT);
});

describe.skipIf(process.platform !== "darwin")("native Mac observation permission gate", () => {
  test("the complete collector typechecks against the Mac SDK without running", () => {
    execFileSync("/usr/bin/swiftc", ["-typecheck", "-"], {
      input: MACOS_OBSERVATION_SCRIPT, encoding: "utf8", timeout: 60_000,
    });
  }, 65_000);

  test("trusted, granted and timed-out gates preserve prompt and wait bounds", () => {
    const output = execFileSync("/usr/bin/swift", ["-"], {
      input: `import Foundation\n${MACOS_OBSERVATION_PERMISSION_SCRIPT}\n` + String.raw`
func scenario(grantedAt: Double?, requestDelay: Double = 0) -> [String: Any] {
  var clock = 0.0
  var requests = 0
  var waits = [Double]()
  var required = 0
  var timedOut = 0
  var captures = 0
  let granted = waitForMacObservationPermission(
    isTrusted: { grantedAt.map { clock >= $0 } ?? false },
    requestPermission: { requests += 1; clock += requestDelay },
    now: { clock },
    wait: { seconds in
      precondition(captures == 0)
      precondition(seconds > 0 && seconds <= 2)
      waits.append(seconds); clock += seconds
    },
    reportRequired: { required += 1 },
    reportTimeout: { timedOut += 1 }
  )
  if granted { captures += 1 }
  return ["granted":granted,"requests":requests,"waits":waits.count,
    "elapsed":clock,"required":required,"timedOut":timedOut,"captures":captures]
}
let result = ["trusted":scenario(grantedAt:0),"granted":scenario(grantedAt:4),
  "timeout":scenario(grantedAt:nil),"deadlineGrant":scenario(grantedAt:120),
  "requestDelay":scenario(grantedAt:nil,requestDelay:1)]
let data = try JSONSerialization.data(withJSONObject:result)
print(String(data:data,encoding:.utf8)!)
`,
      encoding: "utf8", timeout: 60_000,
    });
    expect(JSON.parse(output)).toEqual({
      trusted: { granted: true, requests: 0, waits: 0, elapsed: 0, required: 0, timedOut: 0, captures: 1 },
      granted: { granted: true, requests: 1, waits: 2, elapsed: 4, required: 1, timedOut: 0, captures: 1 },
      timeout: { granted: false, requests: 1, waits: 60, elapsed: 120, required: 1, timedOut: 1, captures: 0 },
      deadlineGrant: { granted: true, requests: 1, waits: 60, elapsed: 120, required: 1, timedOut: 0, captures: 1 },
      requestDelay: { granted: false, requests: 1, waits: 60, elapsed: 120, required: 1, timedOut: 1, captures: 0 },
    });
  }, 65_000);

  test("SIGTERM stops a waiting helper without another prompt or timeout", async () => {
    const child = spawn("/usr/bin/swift", ["-"], {
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stopped = false;
    let waitDeadline: NodeJS.Timeout | undefined;
    const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (_code, signal) => { stopped = true; resolve(signal); });
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const waiting = new Promise<void>((resolve, reject) => {
      waitDeadline = setTimeout(() => reject(new Error("permission fixture did not start waiting")), 60_000);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("permission fixture exited before waiting")));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("waiting\n")) resolve();
      });
    });
    child.stdin.end(`import Foundation\n${MACOS_OBSERVATION_PERMISSION_SCRIPT}\n` + String.raw`
_ = waitForMacObservationPermission(
  isTrusted: { false },
  requestPermission: { print("requested"); fflush(stdout) },
  now: { ProcessInfo.processInfo.systemUptime },
  wait: { seconds in print("waiting"); fflush(stdout); Thread.sleep(forTimeInterval:seconds) },
  reportRequired: {},
  reportTimeout: { print("timed_out"); fflush(stdout) }
)
`);
    try {
      await waiting;
      process.kill(-child.pid!, "SIGTERM");
      expect(await exited).toBe("SIGTERM");
      expect(output.match(/requested/g)).toHaveLength(1);
      expect(output).not.toContain("timed_out");
    } finally {
      clearTimeout(waitDeadline);
      if (!stopped && child.pid) process.kill(-child.pid, "SIGKILL");
      await exited.catch(() => undefined);
    }
  }, 65_000);
});
