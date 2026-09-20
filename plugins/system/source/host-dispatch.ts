import {
  failureResult,
  successResult,
  type ToolImplementation,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";
import {
  executeHostOperation,
  readHostStatus,
} from "./companion/broker-client.js";
import {
  HOST_OPERATIONS,
  type HostOperation,
  type HostStatus,
} from "./companion/protocol.js";
import { SystemOperationError } from "./contracts.js";
import {
  observeCapturedSystemTargets,
  requireSystemRequestRoute,
  type SystemTargetSnapshot,
} from "./request-target-snapshot.js";

export type SystemHostConnection = Readonly<{
  readHostStatus(rootDir: string): Promise<HostStatus>;
  executeHostOperation(
    rootDir: string,
    input: Readonly<{
      hostId: string;
      connectionId: string;
      operation: HostOperation;
      params: Record<string, unknown>;
      abortSignal?: AbortSignal;
    }>,
  ): Promise<ToolImplementationOutput>;
}>;

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
      return await input.connection.executeHostOperation(input.rootDir, {
        hostId: route.hostId,
        connectionId: route.connectionId,
        operation,
        params,
        ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
    } catch (error) {
      if (error instanceof SystemOperationError)
        return failureResult({ errorCode: error.code, message: error.message });
      return failureResult({
        errorCode: "system_execution_route_failed",
        message:
          "The bound execution route failed. No other destination was attempted; effects may be partial if dispatch began.",
      });
    }
  };
}

function hasConnectionControl(params: Record<string, unknown>): boolean {
  if (Object.hasOwn(params, "host_id")) return true;
  if (Object.hasOwn(params, "hostId")) return true;
  return Object.hasOwn(params, "connectionId");
}
