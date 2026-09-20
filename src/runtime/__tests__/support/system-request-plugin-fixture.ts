import { vi } from "vitest";
import { discoverAgentPluginManifests } from "../../plugins/manifest-discovery.js";
import { projectManifestRuntimeContract } from "../../plugins/manifest-projection.js";
import {
  successResult,
  type ToolImplementation,
  type ToolModuleDeclaration,
} from "../../../plugin-sdk/index.js";
import {
  HOST_OPERATIONS,
  type HostStatus,
} from "../../../../plugins/system/source/companion/protocol.js";
import type { SystemHostConnection } from "../../../../plugins/system/source/host-dispatch.js";
import type { SystemTarget } from "../../../../plugins/system/source/contracts.js";
import { observeSystemHost } from "../../../../plugins/system/source/host-observation.js";
import { prepareSystemRequestModules } from "../../../../plugins/system/source/request-system-modules.js";
import { readSystemTargetId } from "../../../../plugins/system/source/targets.js";

export const requestHostId = "550e8400-e29b-41d4-a716-446655440000";
export const requestConnectionId = "550e8400-e29b-41d4-a716-446655440001";
export const connectedSystemHost: HostStatus = {
  paired: true,
  connected: true,
  hostId: requestHostId,
  connectionId: requestConnectionId,
  identity: {
    name: "Owner computer",
    os: "windows",
    user: "owner",
    homeDir: "C:\\Users\\owner",
  },
};
export const linuxNativeTarget: SystemTarget = {
  id: "linux",
  transport: "native",
  shell: "/bin/bash",
};

export function selectedSystemModules(
  selected: readonly string[] = HOST_OPERATIONS,
): readonly ToolModuleDeclaration[] {
  const manifest = discoverAgentPluginManifests(process.cwd()).find(
    (entry) => entry.manifest.name === "system",
  )!;
  return projectManifestRuntimeContract(manifest, selected).capabilities.map(
    (module) => ({
      ...module,
      implementation: async () => {
        throw new Error("unprepared module executed");
      },
    }),
  );
}

export function systemRequestPluginFixture(
  nativeTargets: readonly SystemTarget[] = [linuxNativeTarget],
) {
  const native = vi.fn<ToolImplementation>(async () =>
    successResult({ output: "Native operation settled." }),
  );
  const readHostStatus = vi.fn<SystemHostConnection["readHostStatus"]>(
    async () => connectedSystemHost,
  );
  const remoteResult = successResult({
    output: "Remote operation settled.",
    data: { transport: "host_companion" },
  });
  const executeHostOperation = vi.fn<
    SystemHostConnection["executeHostOperation"]
  >(async () => remoteResult);
  const observeTargets = vi.fn(async () => ({
    host: observeSystemHost({
      platform: "linux",
      kernelRelease: "fixture",
      containerMarker: true,
    }),
    availabilityScope: "command_execution_only" as const,
    targets: nativeTargets.map((target) => ({
      ...target,
      available: true as const,
      commandExecutionAvailable: true as const,
      guiSessionStatus: "not_checked" as const,
    })),
  }));
  const resolvedNativeTargets: SystemTarget[] = [];
  const prepare = (selected?: readonly string[]) =>
    prepareSystemRequestModules("/runtime", selectedSystemModules(selected), {
      observeTargets,
      connection: { readHostStatus, executeHostOperation },
      createNativeHandlers: (resolveTarget) => {
        const handler: ToolImplementation = async (params, context) => {
          resolvedNativeTargets.push(
            await resolveTarget(readSystemTargetId(params.target)),
          );
          return native(params, context);
        };
        return Object.fromEntries(
          HOST_OPERATIONS.map((operation) => [operation, handler]),
        );
      },
    });
  return {
    native,
    readHostStatus,
    executeHostOperation,
    observeTargets,
    prepare,
    remoteResult,
    resolvedNativeTargets,
  };
}
