import {
  failureResult,
  type ToolImplementation,
  type ToolRequestPreparationContext,
  type ToolModuleDeclaration,
} from "../../../../src/plugin-sdk/index.js";
import {
  systemRouteBindingIdentity,
  systemRouteMetadata,
  type SystemTargetSnapshot,
} from "../request-target-snapshot.js";
import type { SystemHostConnection } from "../host-dispatch.js";
import { createComputerHandlers, COMPUTER_TOOLS } from "./handlers.js";
import { RequestComputers } from "./request-computers.js";

/** Load-time placeholders cannot allocate a desktop outside request ownership. */
export function unboundComputerHandlers(): Record<string, ToolImplementation> {
  return Object.fromEntries(
    COMPUTER_TOOLS.map((name) => [
      name,
      async () =>
        failureResult({
          errorCode: "computer_request_binding_required",
          message: "Computer control requires a prepared request.",
        }),
    ]),
  );
}

export function prepareComputerModules(
  rootDir: string,
  modules: readonly ToolModuleDeclaration[],
  routes: SystemTargetSnapshot,
  connection: SystemHostConnection,
  preparation?: ToolRequestPreparationContext,
): readonly ToolModuleDeclaration[] {
  if (modules.length === 0) return [];
  const computers = new RequestComputers(
    rootDir,
    routes,
    connection,
    undefined,
    preparation?.requestState?.read("system.computers.v1"),
  );
  preparation?.requestState?.register("system.computers.v1", {
    snapshot: () => computers.snapshot(),
    dispose: () => computers.close(),
  });
  if (computers.entries.length === 0) return [];
  const handlers = createComputerHandlers(computers);
  const refs = computers.entries.map((entry) => entry.ref);
  return modules.map((module) => ({
    ...module,
    implementation: handlers[module.definition.name]!,
    normalInvocation: {
      ...module.normalInvocation,
      operations: module.normalInvocation.operations.map((operation) => ({
        ...operation,
        input: {
          ...operation.input,
          properties: {
            ...operation.input.properties,
            ...(Object.hasOwn(operation.input.properties, "desktop_ref")
              ? { desktop_ref: { type: "string" as const, enum: refs } }
              : {}),
          },
        },
      })),
    },
    adapter: {
      ...module.adapter,
      executionBinding: (call) => {
        if (call.tool === "computer_desktops")
          return {
            identity: JSON.stringify(
              computers.entries.map((entry) =>
                systemRouteBindingIdentity(entry.route),
              ),
            ),
            metadata: { displayTarget: "available desktops" },
          };
        const entry = computers.require(call.params.desktop_ref);
        return {
          identity: systemRouteBindingIdentity(entry.route),
          metadata: systemRouteMetadata(entry.route),
        };
      },
    },
  }));
}
