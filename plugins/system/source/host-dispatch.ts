import { executeCompanionCommand, supportsCompanionCommandOutput } from "./companion-command-output.js";
import { redactSecretText } from "./security/secret-text.js";
import type { ComputerAccessConnection } from "../../../src/plugin-sdk/computer-access.js";
import {
  failureResult,
  successResult,
  type ToolImplementation,
} from "../../../src/plugin-sdk/index.js";
import {
  executeHostOperation,
  readHostStatus,
} from "../../../src/plugin-sdk/computer-access.js";
import {
  HOST_OPERATIONS,
  HOST_SECRET_PROTECTION_CAPABILITY,
  type HostOperation,
} from "../../../src/plugin-sdk/computer-access.js";
import { SystemOperationError } from "../../../src/plugin-sdk/computer-access.js";
import {
  observeCapturedSystemTargets,
  requireSystemRequestRoute,
  type SystemTargetSnapshot,
} from "./request-target-snapshot.js";

export type SystemHostConnection = ComputerAccessConnection;

export const defaultSystemHostConnection: SystemHostConnection = {
  readHostStatus,
  executeHostOperation,
};

export function createBoundSystemHandlers(
  input: Readonly<{
    rootDir: string;
    snapshot: SystemTargetSnapshot;
    nativeHandlers: Readonly<Record<string, ToolImplementation>>;
    connection: SystemHostConnection;
    outputRetentionMs?: number;
  }>,
): Record<string, ToolImplementation> {
  return Object.fromEntries(
    HOST_OPERATIONS.map((operation) => [
      operation,
      boundOperation(input, operation),
    ]),
  );
}

function boundOperation(
  input: Parameters<typeof createBoundSystemHandlers>[0],
  operation: HostOperation,
): ToolImplementation {
  return async (params, context) => {
    if (hasConnectionControl(params))
      return failureResult({
        errorCode: "system_connection_control_forbidden",
        message:
          "Connection selection is managed internally and is not an operation input.",
      });
    if (operation === "system_targets") {
      const observation = observeCapturedSystemTargets(input.snapshot);
      return successResult({
        output: JSON.stringify(observation),
        data: {
          ...observation,
          observationMeta: { kind: "volatile_external", carryPolicy: "never" },
        },
      });
    }
    try {
      const route = requireSystemRequestRoute(input.snapshot, params.target);
      if (route.kind === "native")
        return await input.nativeHandlers[operation]!(params, context);
      if (!supportsProtectedCompanionResults(route.capabilities))
        return failureResult({
          errorCode: "system_companion_protection_upgrade_required",
          message: "Update Companion to enable protected system results. The operation was not dispatched.",
        });
      if (operation === "system_command" && !supportsCompanionCommandOutput(route))
        return failureResult({
          errorCode: "system_companion_protection_upgrade_required",
          message: "Update Companion to enable protected complete command output. The command was not dispatched.",
        });
      if (operation === "system_command")
        return await executeCompanionCommand({ ...input, route, params, context });
      return await input.connection.executeHostOperation(input.rootDir, {
        hostId: route.hostId,
        connectionId: route.connectionId,
        operation,
        params,
        ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
    } catch (error) {
      if (error instanceof SystemOperationError)
        return failureResult({ errorCode: error.code, message: redactSecretText(error.message) });
      return failureResult({
        errorCode: "system_execution_route_failed",
        message:
          "The bound execution route failed. No other destination was attempted; effects may be partial if dispatch began.",
      });
    }
  };
}

function supportsProtectedCompanionResults(capabilities?: readonly string[]): boolean {
  return capabilities?.includes(HOST_SECRET_PROTECTION_CAPABILITY) === true;
}

function hasConnectionControl(params: Record<string, unknown>): boolean {
  if (Object.hasOwn(params, "host_id")) return true;
  if (Object.hasOwn(params, "hostId")) return true;
  return Object.hasOwn(params, "connectionId");
}
