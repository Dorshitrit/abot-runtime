import type { ToolExecutionSharedState } from "../../../capabilities/tool-types.js";
import { scopeRuntimeTargetPath } from "../../capabilities/runtime-target-path.js";
import {
  validateWorkerCapabilityControls,
  type WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import { executionProtocolError } from "./errors.js";
import { safeIssueCode } from "./values.js";

export function resolveEffectiveOperationTargetControls(
  params: Readonly<{
    descriptor: WorkerCapabilityDescriptor;
    controls: Readonly<Record<string, unknown>>;
    runtimePathBindings: readonly Readonly<{
      param: string;
      default?: ".";
    }>[];
    workingDirectory?: string;
    sharedState: ToolExecutionSharedState;
  }>,
): Readonly<Record<string, unknown>> {
  if (params.runtimePathBindings.length === 0) {
    return params.controls;
  }
  const effectiveEntries = params.runtimePathBindings.map((binding) => {
    const rawTarget = params.controls[binding.param] ?? binding.default;
    if (typeof rawTarget !== "string") {
      throw executionProtocolError("operation_target_control_invalid");
    }
    try {
      return [
        binding.param,
        scopeRuntimeTargetPath({
          rawPath: rawTarget,
          ...(params.workingDirectory
            ? { workingDirectory: params.workingDirectory }
            : {}),
          sharedState: params.sharedState,
        }),
      ] as const;
    } catch (error: unknown) {
      const issueCode =
        error instanceof TypeError ? safeIssueCode(error.message) : undefined;
      throw executionProtocolError(
        issueCode ?? "operation_target_path_invalid",
      );
    }
  });

  const controls = validateWorkerCapabilityControls(
    params.descriptor.controls,
    Object.freeze({
      ...params.controls,
      ...Object.fromEntries(effectiveEntries),
    }),
  );
  if (!controls.ok) {
    throw executionProtocolError(`effective_${controls.issueCode}`);
  }
  return controls.value;
}
