import {
  enforcePluginResultByteBudget,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";
import { isHostRecord, type HostIdentity } from "./companion/protocol.js";

/** Preserve execution provenance without publishing private connection identity. */
export function attachHostEvidence(
  result: ToolImplementationOutput,
  _hostId: string,
  identity: HostIdentity,
): ToolImplementationOutput {
  const data = modelSafeHostResultData(result.data ?? {});
  const output = describeCompanionProcessNamespace(
    result.output,
    data.spawnedProcess,
  );
  return enforcePluginResultByteBudget({
    ...result,
    output: [
      `Execution transport: host_companion; OS target: ${identity.os}.`,
      "This is settled evidence from the selected host, not the runtime/container. A connection or dispatched process does not prove an application window or requested system effect.",
      output,
    ].join("\n"),
    data: {
      ...data,
      ...(typeof data.transport === "string"
        ? { nativeTransport: data.transport }
        : {}),
      transport: "host_companion",
      ...(isHostRecord(data.spawnedProcess)
        ? {
            spawnedProcess: {
              ...data.spawnedProcess,
              pidNamespace: "companion_os",
            },
          }
        : {}),
    },
  });
}

function modelSafeHostResultData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const privateFields = new Set([
    "hostId",
    "host_id",
    "connectionId",
    "hostIdentity",
    "companion",
    "targetSelection",
  ]);
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !privateFields.has(key)),
  );
}

function describeCompanionProcessNamespace(
  output: string,
  spawnedProcess: unknown,
): string {
  if (!isHostRecord(spawnedProcess)) return output;
  const excerptBoundary = output.indexOf("\nSTDOUT excerpt:");
  if (excerptBoundary < 0) return output;
  const header = output.slice(0, excerptBoundary);
  const streams = output.slice(excerptBoundary);
  return (
    header.replace(" in runtime OS namespace.", " in companion OS namespace.") +
    streams
  );
}
