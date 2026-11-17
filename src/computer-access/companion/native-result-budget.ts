import type { ToolImplementationOutput, ToolResultBudget } from "../../plugin-sdk/index.js";
import { HOST_WIRE_MAX_BYTES, type HostAgentMessage } from "./protocol.js";

type NativeResultEnvelope = Extract<HostAgentMessage, { type: "result" }>;

export function nativeResultEnvelope(id: string, result: ToolImplementationOutput): NativeResultEnvelope {
  return { type: "result", id, result };
}

/** This transport sends every result byte, including its exact request wrapper. */
export function createNativeResultBudget(id: string): ToolResultBudget {
  return {
    assess(result) {
      const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      const envelopeBytes = Buffer.byteLength(JSON.stringify(nativeResultEnvelope(id, result)), "utf8");
      return {
        fits: envelopeBytes <= HOST_WIRE_MAX_BYTES,
        serializedBytes,
        envelopeBytes,
        maxBytes: HOST_WIRE_MAX_BYTES,
      };
    },
  };
}
