import type {
  ToolCallAdapter,
  ToolImplementation,
  ToolModuleDeclaration,
} from "../../../src/plugin-sdk/index.js";
import type { SystemTarget, SystemTargetId } from "./contracts.js";
import { isHostOperation } from "./companion/protocol.js";
import { createSystemHandlers } from "./handlers.js";
import {
  createBoundSystemHandlers,
  defaultSystemHostConnection,
  type SystemHostConnection,
} from "./host-dispatch.js";
import {
  observeSystemTargets,
  type SystemTargetObservation,
} from "./target-observation.js";
import {
  captureSystemTargetSnapshot,
  requireSystemRequestRoute,
  resolveCapturedNativeTarget,
  routeTargetId,
  systemRouteBindingIdentity,
  systemRouteMetadata,
  type SystemTargetSnapshot,
} from "./request-target-snapshot.js";

export type SystemRequestDependencies = Readonly<{
  observeTargets?: () => Promise<SystemTargetObservation>;
  connection?: SystemHostConnection;
  createNativeHandlers?: (
    resolveTarget: (id: SystemTargetId) => Promise<SystemTarget>,
  ) => Record<string, ToolImplementation>;
}>;

export async function prepareSystemRequestModules(
  rootDir: string,
  modules: readonly ToolModuleDeclaration[],
  dependencies: SystemRequestDependencies = {},
): Promise<readonly ToolModuleDeclaration[]> {
  if (modules.length === 0) return Object.freeze([]);
  if (modules.some((module) => !isHostOperation(module.definition.name)))
    throw new Error("system_request_module_unknown");
  const connection = dependencies.connection ?? defaultSystemHostConnection;
  const snapshot = await captureSystemTargetSnapshot({
    observeTargets: dependencies.observeTargets ?? observeSystemTargets,
    readHostStatus: () => connection.readHostStatus(rootDir),
  });
  if (snapshot.length === 0) return Object.freeze([]);
  const createNative =
    dependencies.createNativeHandlers ??
    ((resolve) => createSystemHandlers(undefined, resolve));
  const nativeHandlers = createNative(async (target) =>
    resolveCapturedNativeTarget(snapshot, target),
  );
  const handlers = createBoundSystemHandlers({
    rootDir,
    snapshot,
    connection,
    nativeHandlers,
  });
  return Object.freeze(
    modules.map((module) =>
      projectSystemRequestModule(module, snapshot, handlers),
    ),
  );
}

function projectSystemRequestModule(
  module: ToolModuleDeclaration,
  snapshot: SystemTargetSnapshot,
  handlers: Readonly<Record<string, ToolImplementation>>,
): ToolModuleDeclaration {
  const targets = Object.freeze(snapshot.map(routeTargetId));
  const availability = ` Available targets for this request: ${targets.join(", ")}.`;
  return Object.freeze({
    ...module,
    normalInvocation: {
      ...module.normalInvocation,
      operations: module.normalInvocation.operations.map((operation) => ({
        ...operation,
        summary: operation.summary + availability,
        input: {
          ...operation.input,
          properties: {
            ...operation.input.properties,
            ...(Object.hasOwn(operation.input.properties, "target")
              ? { target: { type: "string" as const, enum: targets } }
              : {}),
          },
        },
      })),
    },
    implementation: handlers[module.definition.name]!,
    adapter: {
      ...module.adapter,
      executionBinding: systemExecutionBinding(snapshot),
    },
  });
}

function systemExecutionBinding(
  snapshot: SystemTargetSnapshot,
): NonNullable<ToolCallAdapter["executionBinding"]> {
  return (call) => {
    if (call.tool === "system_targets")
      return {
        identity: JSON.stringify(snapshot.map(systemRouteBindingIdentity)),
        metadata: { displayTarget: snapshot.map(routeTargetId).join(", ") },
      };
    const route = requireSystemRequestRoute(snapshot, call.params.target);
    return {
      identity: systemRouteBindingIdentity(route),
      metadata: systemRouteMetadata(route),
    };
  };
}
