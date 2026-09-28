import type {
  ToolCallAdapter,
  ToolImplementation,
  ToolModuleDeclaration,
  ToolRequestPreparationContext,
} from "../../../src/plugin-sdk/index.js";
import type {
  SystemTarget,
  SystemTargetId,
} from "../../../src/plugin-sdk/computer-access.js";
import { isHostOperation } from "../../../src/plugin-sdk/computer-access.js";
import { isComputerTool } from "./computer/handlers.js";
import { prepareComputerModules } from "./computer/request-modules.js";
import { createSystemHandlers } from "../../../src/plugin-sdk/computer-access.js";
import {
  createBoundSystemHandlers,
  defaultSystemHostConnection,
  type SystemHostConnection,
} from "./host-dispatch.js";
import {
  observeSystemTargets,
  type SystemTargetObservation,
} from "../../../src/plugin-sdk/computer-access.js";
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
  preparation?: ToolRequestPreparationContext,
): Promise<readonly ToolModuleDeclaration[]> {
  if (modules.length === 0) return Object.freeze([]);
  if (modules.some(isUnsupportedSystemModule))
    throw new Error("system_request_module_unknown");
  const connection = dependencies.connection ?? defaultSystemHostConnection;
  const candidates = await captureSystemTargetSnapshot({
    observeTargets: dependencies.observeTargets ?? observeSystemTargets,
    readHostStatus: () => connection.readHostStatus(rootDir),
    includeSameOsCompanion: true,
  });
  // Existing command targeting retains its one-route-per-OS contract.
  const snapshot = uniqueSystemCommandRoutes(candidates);
  const computerModules = prepareComputerModules(
    rootDir,
    modules.filter((module) => isComputerTool(module.definition.name)),
    candidates,
    connection,
    preparation,
  );
  const hasCommandTargets = snapshot.length > 0;
  if (!hasCommandTargets) return Object.freeze(computerModules);
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
  return Object.freeze([
    ...modules
      .filter((module) => !isComputerTool(module.definition.name))
      .map((module) => projectSystemRequestModule(module, snapshot, handlers)),
    ...computerModules,
  ]);
}

function isUnsupportedSystemModule(module: ToolModuleDeclaration): boolean {
  if (isHostOperation(module.definition.name)) return false;
  return !isComputerTool(module.definition.name);
}

function uniqueSystemCommandRoutes(
  candidates: SystemTargetSnapshot,
): SystemTargetSnapshot {
  const seen = new Set<SystemTargetId>();
  return candidates.filter((route) => {
    const target = routeTargetId(route);
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
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
