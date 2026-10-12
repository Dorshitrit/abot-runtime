import {
  failureFromError,
  failureResult,
  readBoundedInteger,
  readOptionalString,
  successResult,
  type ToolImplementation,
} from "../plugin-sdk/index.js";
import { readSystemApplications } from "./application-catalog.js";
import { systemApplicationObservation } from "./application-observation.js";
import { observeSystemTargets } from "./target-observation.js";
import { launchSystemApplication } from "./application-launch.js";
import { executeSystemCommand } from "./commands.js";
import {
  SystemOperationError,
  type SystemApplication,
  type SystemProcessResult,
  type SystemProcessRunner,
  type SystemTarget,
  type SystemTargetId,
} from "./contracts.js";
import type { SystemCommandOutputFactory } from "./command-output.js";
import type { SystemResultProtection } from "./system-result-protection.js";
import { runSystemProcess } from "./process-runner.js";
import { systemProcessResult, type SystemEvidenceScope } from "./process-result.js";
import { readSystemTargetId, resolveSystemTarget } from "./targets.js";

const PROTECTION_FAILURE = "The system result could not be protected for delivery.";

function protectSystemResult<T>(operation: () => T): T {
  try { return operation(); }
  catch {
    throw new SystemOperationError("system_result_protection_failed", PROTECTION_FAILURE);
  }
}

function failedSystemProtectionReceipt(
  target: SystemTarget,
  result: SystemProcessResult,
  evidenceScope: SystemEvidenceScope,
) {
  const safeProcess: SystemProcessResult = {
    status: result.status,
    exitCode: result.exitCode,
    outputTruncated: result.outputTruncated,
    stdout: "[UNAVAILABLE: result protection failed]",
    stderr: "[UNAVAILABLE: result protection failed]",
    ...(result.spawnedProcess ? {
      spawnedProcess: {
        pid: result.spawnedProcess.pid,
        pidNamespace: result.spawnedProcess.pidNamespace,
        identitySource: result.spawnedProcess.identitySource,
        executable: "[REDACTED]",
      },
    } : {}),
  };
  const receipt = systemProcessResult(target, safeProcess, evidenceScope);
  return failureResult({
    errorCode: "system_result_protection_failed",
    message: PROTECTION_FAILURE,
    output: "The operation was dispatched. Inspect the process receipt before another action; the command was not replayed.\n" + receipt.output,
    stdout: safeProcess.stdout,
    stderr: safeProcess.stderr,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    data: receipt.data,
  });
}

function withSystemOperationErrors(
  operation: ToolImplementation,
  protection?: SystemResultProtection,
): ToolImplementation {
  return async (params, context) => {
    try {
      return await operation(params, context);
    } catch (error) {
      let message = error instanceof Error ? error.message : undefined;
      try {
        if (protection && message !== undefined)
          message = protection.protectMessage(message);
      } catch {
        return failureResult({
          errorCode: "system_result_protection_failed",
          message: PROTECTION_FAILURE,
        });
      }
      if (error instanceof SystemOperationError)
        return failureResult({
          errorCode: error.code,
          message: message!,
          data: {
            humanActionRequired: error.code === "system_authorization_required",
          },
        });
      return failureFromError(error, {
        fallbackCode: "system_operation_failed",
        fallbackMessage: "The native system operation failed.",
        operation: "system",
      });
    }
  };
}

export function createSystemHandlers(
  run: SystemProcessRunner = runSystemProcess,
  resolveTarget: (id: SystemTargetId) => Promise<SystemTarget> = (id) =>
    resolveSystemTarget(id, run),
  commandOutput?: SystemCommandOutputFactory,
  protection?: SystemResultProtection,
): Record<string, ToolImplementation> {
  const targets: ToolImplementation = async () => {
    const observed = await observeSystemTargets(run);
    const observation = protection ? protectSystemResult(() => protection.protectTargets(observed)) : observed;
    return successResult({
      output: JSON.stringify(observation),
      data: {
        ...observation,
        observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      },
    });
  };
  const command: ToolImplementation = async (params, context) => {
    const target = await resolveTarget(readSystemTargetId(params.target));
    const output = commandOutput?.(context);
    const observed = await executeSystemCommand({
      target,
      params,
      run,
      ...(output ? { runCommand: output.run } : {}),
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
    let result = observed;
    try {
      if (protection) result = protection.protectProcess(observed);
    } catch {
      return failedSystemProtectionReceipt(target, observed, "command_process_completion");
    }
    if (output) return output.present(target, result);
    return systemProcessResult(target, result, "command_process_completion");
  };
  const applications: ToolImplementation = async (params) => {
    const target = await resolveTarget(readSystemTargetId(params.target));
    const query = (readOptionalString(params.query) ?? "").toLowerCase();
    const limit =
      params.limit === undefined
        ? 50
        : readBoundedInteger(params.limit, {
            name: "limit",
            minimum: 1,
            maximum: 100,
          });
    const observed = await readSystemApplications(target, run);
    const catalog = protection ? protectSystemResult(() => protection.protectCatalog(observed)) : observed;
    const { output, data } = systemApplicationObservation(
      target,
      catalog,
      query,
      limit,
    );
    return successResult({
      output,
      data: {
        ...data,
        observationMeta: { kind: "volatile_external", carryPolicy: "never" },
      },
    });
  };
  const launch: ToolImplementation = async (params, context) => {
    const target = await resolveTarget(readSystemTargetId(params.target));
    const result = await launchSystemApplication({
      target,
      params,
      run,
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
    let process = result.process;
    let application: SystemApplication | undefined = result.application;
    try {
      if (protection) {
        process = protection.protectProcess(result.process);
        application = protection.protectApplication(result.application);
      }
    } catch {
      return failedSystemProtectionReceipt(target, result.process, "launch_request_dispatch");
    }
    return systemProcessResult(
      target,
      process,
      "launch_request_dispatch",
      application,
    );
  };
  return {
    system_targets: withSystemOperationErrors(targets, protection),
    system_command: withSystemOperationErrors(command, protection),
    system_applications: withSystemOperationErrors(applications, protection),
    system_launch: withSystemOperationErrors(launch, protection),
  };
}
