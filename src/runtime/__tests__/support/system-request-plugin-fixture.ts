import { vi } from "vitest";
import { createHash } from "node:crypto";
import { HOST_SECRET_PROTECTION_CAPABILITY } from "../../../computer-access/companion/secret-protection-protocol.js";
import { SYSTEM_OUTPUT_CAPABILITY, SYSTEM_OUTPUT_CHUNK_BYTES } from "../../../computer-access/companion/command-output-protocol.js";
import { COMPUTER_CAPABILITY } from "../../../computer-access/computer/native-validation.js";
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
} from "../../../computer-access/companion/protocol.js";
import type { SystemHostConnection } from "../../../../plugins/system/source/host-dispatch.js";
import type { SystemTarget } from "../../../computer-access/contracts.js";
import { observeSystemHost } from "../../../computer-access/host-observation.js";
import { prepareSystemRequestModules } from "../../../../plugins/system/source/request-system-modules.js";
import { readSystemTargetId } from "../../../computer-access/targets.js";

export const requestHostId = "550e8400-e29b-41d4-a716-446655440000";
export const requestConnectionId = "550e8400-e29b-41d4-a716-446655440001";
export const connectedSystemHost: HostStatus = {
  paired: true,
  connected: true,
  hostId: requestHostId,
  connectionId: requestConnectionId,
  capabilities: [HOST_SECRET_PROTECTION_CAPABILITY, SYSTEM_OUTPUT_CAPABILITY, COMPUTER_CAPABILITY],
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
  const commandOutput = "Captured command output.";
  const bytes = Buffer.from(commandOutput);
  const captureId = "550e8400-e29b-41d4-a716-446655440003";
  const commandReceipt = {
    ...remoteResult, stdout: "", stderr: "", exitCode: 0,
    data: { ...remoteResult.data, processStatus: "completed", outputTransfer: {
      kind: SYSTEM_OUTPUT_CAPABILITY, id: captureId, stdoutBytes: bytes.length, stderrBytes: 0,
      stdoutSha256: createHash("sha256").update(bytes).digest("hex"),
      stderrSha256: createHash("sha256").update("").digest("hex"),
    } },
  };
  const executeHostOperation = vi.fn<
    SystemHostConnection["executeHostOperation"]
  >(async (_root, call) => {
    if (call.operation === "system_command_capture") return commandReceipt;
    if (call.operation === "system_command_output") {
      const offset = call.params.offset as number;
      return successResult({ output: "Fixture output chunk.", data: {
        captureId, stream: call.params.stream, offset,
        bytes: bytes.subarray(offset, offset + SYSTEM_OUTPUT_CHUNK_BYTES).toString("base64"),
      } });
    }
    if (call.operation === "system_command_output_close")
      return successResult({ output: "Fixture transfer closed." });
    return remoteResult;
  });
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
    commandOutput,
    resolvedNativeTargets,
  };
}
