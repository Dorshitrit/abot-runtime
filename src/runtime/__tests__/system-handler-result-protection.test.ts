import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { SystemOperationError, type SystemProcessRunner } from "../../computer-access/contracts.js";
import { buildSystemProcessResult } from "../../computer-access/process-result.js";
import type { SystemCommandOutputFactory } from "../../computer-access/command-output.js";
import {
  lateSensitiveText, sensitiveText, systemProtectionOwners, testSystemApplication,
  testSystemCatalog, testSystemProcess, testSystemTarget, testSystemTargets,
} from "./support/system-result-protection-fixture.js";

const observations = vi.hoisted(() => ({ targets: vi.fn(), catalog: vi.fn() }));
vi.mock("../../computer-access/target-observation.js", () => ({ observeSystemTargets: observations.targets }));
vi.mock("../../computer-access/application-catalog.js", () => ({ readSystemApplications: observations.catalog }));
const command = { target: "windows", cwd: "C:\\fixture", command: "fixture command" };
beforeEach(() => {
  observations.targets.mockReset().mockResolvedValue(testSystemTargets(lateSensitiveText));
  observations.catalog.mockReset().mockResolvedValue(testSystemCatalog([]));
});

describe.each(systemProtectionOwners)("$owner protected handler receipts", ({ protection }) => {
  const resolveTarget = async () => testSystemTarget;

  test("target output and data are protected before JSON formatting", async () => {
    const handlers = createSystemHandlers(vi.fn(), resolveTarget, undefined, protection);
    const receipt = await handlers.system_targets!({});
    expect(receipt.ok).toBe(true);
    expect(receipt.data).toMatchObject({
      host: { kernelRelease: "[REDACTED]" },
      targets: [{ id: "windows", available: false }, { id: "macos", available: false, reason: "[REDACTED]" }],
    });
    expect(JSON.parse(receipt.output)).toMatchObject({ host: { kernelRelease: "[REDACTED]" } });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
  });

  test("catalog filtering and summaries use protected names, roots and exact safe IDs", async () => {
    observations.catalog.mockResolvedValue(testSystemCatalog([
      testSystemApplication(sensitiveText, "Hidden"),
      testSystemApplication("Safe.App", lateSensitiveText),
    ], lateSensitiveText));
    const handlers = createSystemHandlers(vi.fn(), resolveTarget, undefined, protection);
    const receipt = await handlers.system_applications!({ target: "windows" });
    expect(receipt.data).toMatchObject({
      catalogComplete: false, absenceConclusionSupported: false,
      catalogScope: { roots: ["[REDACTED]"] },
      applications: [{ id: "Safe.App", name: "[REDACTED]", target: "windows" }],
    });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
    expect(JSON.stringify(receipt)).not.toContain("ordinary context");
    const filtered = await handlers.system_applications!({ target: "windows", query: "synthetic-private" });
    expect(filtered.data).toMatchObject({ observedMatches: 0, applications: [] });
  });

  test.each([false, true])("launch receipt preserves dispatch evidence with sensitive identity=%s", async (sensitiveId) => {
    const application = testSystemApplication(sensitiveId ? sensitiveText : "Safe.App", lateSensitiveText);
    observations.catalog.mockResolvedValue(testSystemCatalog([application]));
    const run = vi.fn<SystemProcessRunner>(async () => testSystemProcess(lateSensitiveText));
    const handlers = createSystemHandlers(run, resolveTarget, undefined, protection);
    const receipt = await handlers.system_launch!({ target: "windows", application_id: application.id });
    expect(run).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      ok: false, exitCode: 7, stdout: "[REDACTED]", stderr: "[REDACTED]",
      data: {
        evidenceScope: "launch_request_dispatch", independentOutcomeCheck: "not_performed",
        processStatus: "completed", spawnedProcess: { pid: 123, executable: "[REDACTED]" },
      },
    });
    if (sensitiveId) expect(receipt.data).not.toHaveProperty("catalogApplication");
    else expect(receipt.data).toHaveProperty("catalogApplication", { ...application, name: "[REDACTED]" });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
    expect(JSON.stringify(receipt)).not.toContain("ordinary context");
  });

  test("command protects the full streams before the first excerpt or custom output presenter", async () => {
    const run = vi.fn<SystemProcessRunner>(async () => testSystemProcess(lateSensitiveText));
    const present = vi.fn<ReturnType<SystemCommandOutputFactory>["present"]>(async (target, result) => buildSystemProcessResult(target, result, "command_process_completion"));
    const output: SystemCommandOutputFactory = () => ({ run, present });
    const handlers = createSystemHandlers(run, resolveTarget, output, protection);
    const receipt = await handlers.system_command!(command);
    expect(run).toHaveBeenCalledOnce();
    expect(present).toHaveBeenCalledWith(testSystemTarget, expect.objectContaining({
      stdout: "[REDACTED]", stderr: "[REDACTED]",
      spawnedProcess: expect.objectContaining({ executable: "[REDACTED]" }),
    }));
    expect(receipt.data).toMatchObject({ evidenceScope: "command_process_completion", processStatus: "completed" });
    expect(JSON.stringify(receipt)).not.toContain("ordinary context");
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
  });

  test("an existing truncated process keeps status and PID but exposes no partial streams", async () => {
    const run = vi.fn<SystemProcessRunner>(async () => ({
      ...testSystemProcess("ordinary partial fragment"), status: "timeout", exitCode: null, outputTruncated: true,
    }));
    const handlers = createSystemHandlers(run, resolveTarget, undefined, protection);
    const receipt = await handlers.system_command!(command);
    expect(receipt).toMatchObject({
      ok: false, errorCode: "system_timeout",
      stdout: "[UNAVAILABLE: incomplete output cannot be scanned for secrets]",
      data: { processStatus: "timeout", outputTruncated: true, spawnedProcess: { pid: 123 } },
    });
    expect(receipt).not.toHaveProperty("exitCode");
    expect(receipt.output).not.toContain("STDOUT excerpt:\nordinary partial fragment");
  });

  test("full error message is scanned before failure formatting", async () => {
    const resolve = async () => { throw new SystemOperationError("system_authorization_required", lateSensitiveText); };
    const handlers = createSystemHandlers(vi.fn(), resolve, undefined, protection);
    const receipt = await handlers.system_command!(command);
    expect(receipt).toMatchObject({
      ok: false, errorCode: "system_authorization_required", error: "[REDACTED]", output: "[REDACTED]",
      data: { humanActionRequired: true },
    });
  });

  test("ordinary callers without hooks retain their existing result contract", async () => {
    const run = vi.fn<SystemProcessRunner>(async () => testSystemProcess(sensitiveText));
    const receipt = await createSystemHandlers(run, resolveTarget).system_command!(command);
    expect(receipt.stdout).toBe(sensitiveText);
  });
});

test.each(["protectTargets", "protectCatalog", "protectProcess", "protectApplication", "protectMessage"] as const)(
  "%s policy failure never returns the thrown payload", async (hook) => {
    observations.catalog.mockResolvedValue(testSystemCatalog([testSystemApplication()]));
    const protection = {
      ...systemProtectionOwners[0]!.protection,
      [hook]: () => { throw new Error("opaque-private-failure"); },
    };
    const resolve = async () => {
      if (hook === "protectMessage") throw new SystemOperationError("system_failure", sensitiveText);
      return testSystemTarget;
    };
    const handlers = createSystemHandlers(async () => testSystemProcess(), resolve, undefined, protection);
    const tool = hook === "protectTargets" ? "system_targets" : hook === "protectCatalog" ? "system_applications"
      : hook === "protectApplication" ? "system_launch" : "system_command";
    const receipt = await handlers[tool]!({ ...command, application_id: "Fixture.App" });
    expect(receipt).toMatchObject({
      ok: false, errorCode: "system_result_protection_failed",
      error: "The system result could not be protected for delivery.",
    });
    expect(JSON.stringify(receipt)).not.toContain("opaque-private-failure");
    expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
  },
);


test.each([
  { operation: "system_command", hook: "protectProcess", scope: "command_process_completion" },
  { operation: "system_launch", hook: "protectProcess", scope: "launch_request_dispatch" },
  { operation: "system_launch", hook: "protectApplication", scope: "launch_request_dispatch" },
] as const)("$operation $hook failure retains only the safe dispatched receipt", async ({ operation, hook, scope }) => {
  const application = testSystemApplication(sensitiveText, sensitiveText);
  observations.catalog.mockResolvedValue(testSystemCatalog([application]));
  const raw = testSystemProcess(lateSensitiveText);
  const run = vi.fn<SystemProcessRunner>(async () => raw);
  const present = vi.fn<ReturnType<SystemCommandOutputFactory>["present"]>();
  const protection = {
    ...systemProtectionOwners[0]!.protection,
    [hook]: () => { throw new Error("opaque-private-failure"); },
  };
  const output: SystemCommandOutputFactory = () => ({ run, present });
  const handlers = createSystemHandlers(run, async () => testSystemTarget, output, protection);
  const receipt = await handlers[operation]!({ ...command, application_id: application.id });
  expect(run).toHaveBeenCalledOnce();
  expect(present).not.toHaveBeenCalled();
  expect(receipt).toMatchObject({
    ok: false, errorCode: "system_result_protection_failed", exitCode: 7,
    stdout: "[UNAVAILABLE: result protection failed]", stderr: "[UNAVAILABLE: result protection failed]",
    data: {
      evidenceScope: scope, independentOutcomeCheck: "not_performed", processStatus: "completed",
      spawnedProcess: { pid: 123, pidNamespace: "runtime_os", identitySource: "spawn_arguments", executable: "[REDACTED]" },
    },
  });
  expect(receipt.output).toContain("The operation was dispatched.");
  expect(receipt.output).toContain("the command was not replayed");
  expect(receipt.data).not.toHaveProperty("catalogApplication");
  expect(JSON.stringify(receipt)).not.toContain("opaque-private-failure");
  expect(JSON.stringify(receipt)).not.toContain("synthetic-private");
  expect(JSON.stringify(receipt)).not.toContain("ordinary context");
});
