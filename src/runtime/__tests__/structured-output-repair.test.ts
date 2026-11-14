import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import type { ModelGatewayClient } from "../ports.js";
import { invokeStructuredModelStep } from "../model/invoke-structured-step.js";
import { resolveStructuredOutputRepair } from "../model/structured-output-repair.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createInvalidOutputRequest } from "./support/invalid-output-request.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const format: ModelGatewayJsonSchemaFormat = {
  type: "json_schema", name: "bounded_decision", strict: true,
  schema: {
    type: "object", required: ["decision"], additionalProperties: false,
    properties: { decision: { type: "string", enum: ["accepted", "unavailable"] } },
  },
};
const accepted = JSON.stringify({ decision: "accepted" });
const messages: ChatMessage[] = [
  { role: "system", content: "Choose a permitted decision." },
  { role: "user", content: "Earlier request." },
  { role: "assistant", content: "Earlier response." },
  { role: "user", content: "Continue." },
];

function runStep(invoke: ModelGatewayClient["invoke"]) {
  const request = createInvalidOutputRequest(invoke);
  return invokeStructuredModelStep({
    request, modelStep: "supervisor.decision", messages, format,
    timeoutReason: "test_timeout", invalidOutputReason: "test_invalid",
    parse: (text) => text === accepted
      ? { ok: true, decision: "accepted" }
      : { ok: false, stage: "domain_parser", issues: [
          { code: "decision_rejected", path: "decision", message: "Choose an available decision." },
        ] },
  });
}

describe("attempt-local structured format repair", () => {
  test.each(["plain acknowledgement", '"scalar"', "{}", '{"decision":false}'])(
    "marks an existing repair after rejected JSON/schema output: %s", async (rejected) => {
      const before = structuredClone({ messages, format });
      const invoke = vi.fn<ModelGatewayClient["invoke"]>()
        .mockResolvedValueOnce({ text: rejected, meta: { providerCompletionReason: "stop" } })
        .mockResolvedValueOnce({ text: accepted, meta: { providerCompletionReason: "stop" } });
      await expect(runStep(invoke)).resolves.toBe("accepted");
      const inputs = invoke.mock.calls.map(([input]) => input);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).not.toHaveProperty("structuredOutputRepair");
      expect(inputs[1]?.structuredOutputRepair).toBe("json_schema_violation");
      expect(inputs[1]?.agentMode).toBe(inputs[0]?.agentMode);
      expect(inputs[1]?.modelPolicy).toEqual(inputs[0]?.modelPolicy);
      expect(inputs[1]?.format).toEqual(format);
      const repairedMessages = inputs[1]?.messages as ChatMessage[];
      expect(repairedMessages[0]).toEqual(messages[0]);
      expect(repairedMessages.slice(2)).toEqual(messages.slice(1));
      expect({ messages, format }).toEqual(before);
    },
  );

  test("a schema-valid semantic rejection clears the format marker for the next repair", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValueOnce({ text: "invalid", meta: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ decision: "unavailable" }), meta: {} })
      .mockResolvedValueOnce({ text: accepted, meta: {} });
    await expect(runStep(invoke)).resolves.toBe("accepted");
    expect(invoke.mock.calls.map(([input]) => input.structuredOutputRepair))
      .toEqual([undefined, "json_schema_violation", undefined]);
  });

  test("does not mark a successful first attempt or leak repair state into the next step", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValueOnce({ text: "invalid", meta: {} })
      .mockResolvedValue({ text: accepted, meta: {} });
    await runStep(invoke);
    await runStep(invoke);
    expect(invoke.mock.calls.map(([input]) => input.structuredOutputRepair))
      .toEqual([undefined, "json_schema_violation", undefined]);
  });

  test("keeps the existing two-repair ceiling and never manufactures an accepted decision", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValue({ text: "invalid", meta: { providerCompletionReason: "stop" } });
    await expect(runStep(invoke)).rejects.toMatchObject({
      name: "StructuredModelInvalidOutputError", repairAttempts: 2, repeatedInvalidOutput: true,
    });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test("truncated output remains a completion failure without a repair", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>()
      .mockResolvedValue({ text: "{", meta: { providerCompletionReason: "length" } });
    await expect(runStep(invoke)).rejects.toMatchObject({ code: "output_incomplete" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("a provider failure does not enter format repair", async () => {
    const failure = new Error("provider_timeout");
    const invoke = vi.fn<ModelGatewayClient["invoke"]>().mockRejectedValue(failure);
    await expect(runStep(invoke)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("unsupported schema keywords do not turn a domain rejection into a format violation", () => {
    expect(resolveStructuredOutputRepair('"not-a-date"', {
      type: "json_schema", name: "domain_constraint", schema: { type: "string", format: "date-time" },
    })).toBeUndefined();
  });
});
