import { describe, expect, test } from "vitest";
import { observeSystemHost } from "../../computer-access/host-observation.js";
import { systemProcessResult } from "../../computer-access/process-result.js";
import type {
  SystemApplication,
  SystemProcessResult,
  SystemTarget,
} from "../../computer-access/contracts.js";
import {
  boundedSummary,
  projectObservationOutput,
} from "../adapters/registered-tool-worker-capabilities/result-evidence.js";
import { ROLE_CALL_RESULT_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";
import type { ToolImplementationOutput } from "../../capabilities/tool-types.js";

const windowsTarget: SystemTarget = {
  id: "windows",
  transport: "wsl_interop",
  shell: "/observed/windows/powershell.exe",
};
const completed: SystemProcessResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  status: "completed",
  outputTruncated: false,
};

function observeMixedProcessReceipt(
  receipt: ToolImplementationOutput,
  directRoot: boolean,
) {
  return observeExternalResult(
    {
      status: "executed",
      effect: "mixed",
      result: { tool: "fixture_process", ...receipt },
      completionActions: [],
    },
    "mixed",
    directRoot,
  ).result;
}

describe("observed host and runtime are distinct facts", () => {
  test.each([
    { platform: "linux", kernelRelease: "6.8.0-generic", runtimeOs: "linux" },
    { platform: "darwin", kernelRelease: "24.5.0", runtimeOs: "macos" },
    { platform: "win32", kernelRelease: "10.0.26100", runtimeOs: "windows" },
  ] as const)(
    "$platform observes its platform without claiming a GUI session",
    ({ platform, kernelRelease, runtimeOs }) => {
      expect(observeSystemHost({ platform, kernelRelease })).toEqual({
        runtimeOs,
        kernelRelease,
        environment: "not_identified_as_wsl",
        inferredHostOs: runtimeOs,
        hostInferenceSource: "runtime_platform_only",
        windowsExecutionRequiresProbe: platform === "win32",
        guiSessionStatus: "not_checked",
      });
    },
  );

  test.each(["test-kernel-microsoft-standard-WSL2", "test-kernel-Microsoft"])(
    "WSL kernel %s identifies a Windows host without claiming working interop",
    (kernelRelease) => {
      const observation = observeSystemHost({
        platform: "linux",
        kernelRelease,
      });
      expect(observation).toEqual({
        runtimeOs: "linux",
        kernelRelease,
        environment: "wsl_guest",
        inferredHostOs: "windows",
        hostInferenceSource: "wsl_kernel_signature",
        windowsExecutionRequiresProbe: true,
        guiSessionStatus: "not_checked",
      });
      expect(observation).not.toHaveProperty("availableTargets");
    },
  );

  test("a non-Linux Microsoft kernel string does not identify WSL", () => {
    expect(
      observeSystemHost({ platform: "win32", kernelRelease: "Microsoft" }),
    ).toMatchObject({
      runtimeOs: "windows",
      environment: "not_identified_as_wsl",
    });
  });

  test("an unsupported platform cannot become an available known target", () => {
    expect(
      observeSystemHost({ platform: "freebsd", kernelRelease: "14.2" }),
    ).toMatchObject({
      runtimeOs: "unsupported",
      inferredHostOs: "unsupported",
    });
  });
});

describe("process receipts preserve the exact scope of observed evidence", () => {
  test("a no-op exit zero records command completion without a system effect", () => {
    const receipt = systemProcessResult(
      windowsTarget,
      completed,
      "command_process_completion",
    );
    expect(receipt).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      data: {
        evidenceScope: "command_process_completion",
        independentOutcomeCheck: "not_performed",
        processStatus: "completed",
        spawnedProcess: null,
        observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      },
    });
    expect(receipt.data).not.toHaveProperty("mutationEvidence");
    expect(receipt.data).not.toHaveProperty("catalogApplication");
    expect(receipt.data).not.toHaveProperty("currentStateEvidence");
    expect(observeMixedProcessReceipt(receipt, true)).toMatchObject({
      outcome: "succeeded",
      observedEffect: "observation",
      summary: receipt.output,
    });
  });

  test("a launch helper PID and catalog identity do not claim a running application", () => {
    const application: SystemApplication = {
      id: "observed-app!Entry",
      name: "Observed app",
      target: "windows",
    };
    const spawnedProcess = {
      pid: 4201,
      pidNamespace: "runtime_os" as const,
      executable: windowsTarget.shell,
      identitySource: "spawn_arguments" as const,
    };
    const receipt = systemProcessResult(
      windowsTarget,
      { ...completed, stdout: "dispatch requested", spawnedProcess },
      "launch_request_dispatch",
      application,
    );
    expect(receipt.data).toMatchObject({
      target: "windows",
      transport: "wsl_interop",
      evidenceScope: "launch_request_dispatch",
      independentOutcomeCheck: "not_performed",
      spawnedProcess,
      catalogApplication: application,
    });
    expect(receipt.data).not.toHaveProperty("mutationEvidence");
    expect(receipt.data).not.toHaveProperty("applicationProcess");
    expect(receipt.data).not.toHaveProperty("window");
    expect(receipt.data).not.toHaveProperty("applicationRunning");
    expect(observeMixedProcessReceipt(receipt, true)).toMatchObject({
      outcome: "succeeded",
      observedEffect: "observation",
      summary: receipt.output,
    });
  });

  test("command-produced process observations remain available for evaluating the result", () => {
    const processObservation = {
      Id: 81,
      Path: "C:\\Program Files\\Observed App\\application.exe",
      MainWindowHandle: 101,
    };
    const stdout = JSON.stringify(processObservation);
    const receipt = systemProcessResult(
      windowsTarget,
      { ...completed, stdout },
      "command_process_completion",
    );
    expect(receipt.ok).toBe(true);
    expect(JSON.parse(receipt.stdout!)).toEqual(processObservation);
    expect(receipt.output).toContain(stdout);
    expect(receipt.data).toMatchObject({
      independentOutcomeCheck: "not_performed",
      summaryOmittedChars: { stdout: 0, stderr: 0 },
    });
    expect(receipt.data).not.toHaveProperty("applicationRunning");
  });

  test.each([false, true])(
    "large streams preserve scoped summary through canonical projection, directRoot=%s",
    (directRoot) => {
      const stdout = "OUT:" + "o".repeat(15_996);
      const stderr = "ERR:" + "e".repeat(15_996);
      const application: SystemApplication = {
        id: "app-" + "a".repeat(16_000),
        name: "Observed application",
        target: "windows",
      };
      const receipt = systemProcessResult(
        windowsTarget,
        {
          ...completed,
          stdout,
          stderr,
          outputTruncated: true,
          spawnedProcess: {
            pid: 42,
            pidNamespace: "runtime_os",
            executable: "/" + "e".repeat(16_000),
            identitySource: "spawn_arguments",
          },
        },
        "launch_request_dispatch",
        application,
      );
      expect(receipt.stdout).toBe(stdout);
      expect(receipt.stderr).toBe(stderr);
      expect(receipt.data).toMatchObject({
        evidenceScope: "launch_request_dispatch",
        independentOutcomeCheck: "not_performed",
        outputTruncated: true,
        summaryOmittedChars: { stdout: 14_000, stderr: 14_000 },
        catalogApplication: application,
      });
      expect(receipt.output.length).toBeLessThanOrEqual(
        ROLE_CALL_RESULT_MAX_LENGTH,
      );
      expect(receipt.output).toContain(stdout.slice(0, 2_000));
      expect(receipt.output).toContain(stderr.slice(0, 2_000));
      expect(boundedSummary(receipt.output, directRoot)).toBe(receipt.output);
      expect(projectObservationOutput(receipt.output, directRoot)).toEqual({
        summary: receipt.output,
      });
      expect(observeMixedProcessReceipt(receipt, directRoot)).toMatchObject({
        outcome: "succeeded",
        observedEffect: "observation",
        summary: receipt.output,
        exactResult: {
          kind: "registered_tool_execution_result_v1",
          result: {
            stdout,
            stderr,
            data: {
              evidenceScope: "launch_request_dispatch",
              independentOutcomeCheck: "not_performed",
            },
          },
        },
      });
    },
  );
});
