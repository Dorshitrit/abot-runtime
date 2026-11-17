import type { ToolResultBudget } from "../../plugin-sdk/index.js";
import { HOST_WIRE_MAX_BYTES } from "./protocol.js";

/** The broker client counts the complete response, including its line delimiter. */
export const brokerResultBudget: ToolResultBudget = {
  assess(result) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ ok: true, result }) + "\n", "utf8");
    return { fits: envelopeBytes <= HOST_WIRE_MAX_BYTES, serializedBytes, envelopeBytes, maxBytes: HOST_WIRE_MAX_BYTES };
  },
};
