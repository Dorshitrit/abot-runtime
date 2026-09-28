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
  type SystemProcessRunner,
  type SystemTarget,
  type SystemTargetId,
} from "./contracts.js";
import { runSystemProcess } from "./process-runner.js";
import { systemProcessResult } from "./process-result.js";
import { readSystemTargetId, resolveSystemTarget } from "./targets.js";

function withSystemOperationErrors(
  operation: ToolImplementation,
): ToolImplementation {
  return async (params, context) => {
    try {
      return await operation(params, context);
    } catch (error) {
      if (error instanceof SystemOperationError)
        return failureResult({
          errorCode: error.code,
          message: error.message,
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
): Record<string, ToolImplementation> {
  const targets: ToolImplementation = async () => {
    const observation = await observeSystemTargets(run);
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
    const result = await executeSystemCommand({
      target,
      params,
      run,
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
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
    const catalog = await readSystemApplications(target, run);
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
    return systemProcessResult(
      target,
      result.process,
      "launch_request_dispatch",
      result.application,
    );
  };
  return {
    system_targets: withSystemOperationErrors(targets),
    system_command: withSystemOperationErrors(command),
    system_applications: withSystemOperationErrors(applications),
    system_launch: withSystemOperationErrors(launch),
  };
}
