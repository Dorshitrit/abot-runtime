import type { SystemApplicationCatalog } from "../../../computer-access/application-catalog.js";
import type { SystemApplication, SystemProcessResult, SystemTarget } from "../../../computer-access/contracts.js";
import type { SystemTargetObservation } from "../../../computer-access/target-observation.js";
import { systemResultProtection as native } from "../../../computer-access/security/system-results.js";
import { systemResultProtection as plugin } from "../../../../plugins/system/source/security/system-results.js";

export const systemProtectionOwners = [
  { owner: "native", protection: native },
  { owner: "SYSTEM plugin", protection: plugin },
];
export const sensitiveText = ["ordinary prefix", "password=synthetic-private", "ordinary suffix"].join(String.fromCharCode(10));
export const lateSensitiveText = "ordinary context ".repeat(4_000) + sensitiveText;
export const testSystemTarget: SystemTarget = {
  id: "windows", transport: "wsl_interop", shell: "/fixture/powershell.exe",
};

export function testSystemProcess(text = "ordinary output"): SystemProcessResult {
  return {
    exitCode: 7, status: "completed", stdout: text, stderr: text, outputTruncated: false,
    spawnedProcess: {
      pid: 123, pidNamespace: "runtime_os", executable: text, identitySource: "spawn_arguments",
    },
  };
}
export function testSystemApplication(id = "Fixture.App", name = "Fixture Application"): SystemApplication {
  return { id, name, target: "windows" };
}
export function testSystemCatalog(applications: readonly SystemApplication[], root = "/fixture"): SystemApplicationCatalog {
  return {
    complete: true, applications,
    scope: { source: "windows_start_apps", roots: [root], includesExecutableSearch: false, includesOtherTargets: false },
  };
}
export function testSystemTargets(text = "/ordinary/shell"): SystemTargetObservation {
  return {
    host: {
      runtimeOs: "linux", kernelRelease: text, environment: "wsl_guest",
      inferredHostOs: "windows", hostInferenceSource: "wsl_kernel_signature",
      windowsExecutionRequiresProbe: true, guiSessionStatus: "not_checked",
    },
    availabilityScope: "command_execution_only",
    targets: [
      { ...testSystemTarget, shell: text, available: true, commandExecutionAvailable: true, guiSessionStatus: "not_checked" },
      { id: "macos", available: false, reason: text },
    ],
  };
}
