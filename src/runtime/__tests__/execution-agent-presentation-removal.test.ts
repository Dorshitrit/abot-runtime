import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import type { ModelGatewayClient } from "../ports.js";
import { runRequestRunner } from "../request/runner.js";
import {
  createExecutionAgentDecisionFormat,
  parseExecutionAgentDecisionOutput,
} from "../steps/execution-agent/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const capability = {
  capabilityId: "observe_target",
  summary: "Observe the selected target.",
  effect: "observation",
  controls: {
    type: "object", additionalProperties: false,
    properties: { target: { type: "string", minLength: 1, maxLength: 256 } },
    required: ["target"],
  },
  selectionControlIds: ["target"],
} as const satisfies CapabilityDescriptor;
const contract = { capabilities: [capability], maxBatchCapabilityExecutions: 2 };
const invocation = { capabilityId: capability.capabilityId, selectionControls: { target: "first" } };

function parse(decision: Record<string, unknown>) {
  return parseExecutionAgentDecisionOutput(JSON.stringify({ decision }), contract);
}

function schemaPropertyNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaPropertyNames);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record.properties && typeof record.properties === "object"
    ? Object.keys(record.properties) : [];
  return [...own, ...Object.values(record).flatMap(schemaPropertyNames)];
}

test("EA single and batch decisions accept controls without a model-authored intent field", () => {
  const names = schemaPropertyNames(createExecutionAgentDecisionFormat(contract).schema);
  expect(names).not.toContain("intent");
  expect(parse({ action: "invoke_capability", ...invocation })).toMatchObject({
    ok: true,
    decision: { capabilityId: capability.capabilityId, controls: { target: "first" } },
  });
  expect(parse({ action: "invoke_capabilities", invocations: [
    invocation, { ...invocation, selectionControls: { target: "second" } },
  ] })).toMatchObject({ ok: true });
});

test.each([false, true])("obsolete intent is rejected for batch=%s before execution", (batch) => {
  const obsolete = { ...invocation, intent: "Legacy model-authored explanation." };
  const decision = batch
    ? { action: "invoke_capabilities", invocations: [obsolete, invocation] }
    : { action: "invoke_capability", ...obsolete };
  expect(parse(decision)).toMatchObject({ ok: false });
});

test.each(["respond", "blocked"] as const)(
  "fresh EA %s keeps title and final presentation without acknowledgement",
  async (action) => {
    const response = action === "respond" ? "The exact answer." : "The required source is unavailable.";
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
      expect(input.modelStep).toBe("execution.decision");
      expect(schemaPropertyNames(input.format)).not.toContain("acknowledgement");
      expect(schemaPropertyNames(input.format)).not.toContain("intent");
      return { text: JSON.stringify({ decision: { action, response, title: "Requested result" } }), meta: {} };
    });
    const onAcknowledgement = vi.fn();
    const onSessionTitle = vi.fn(async () => {});
    const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
      shouldGenerateSessionTitle: true, onAcknowledgement, onSessionTitle,
    });

    const result = await runRequestRunner(request);

    expect(result.output).toBe(response);
    expect(invoke).toHaveBeenCalledOnce();
    expect(onAcknowledgement).not.toHaveBeenCalled();
    expect(onSessionTitle).toHaveBeenCalledExactlyOnceWith("Requested result");
    expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith(response);
  },
);

test("EA rejects an obsolete acknowledgement and publishes only the accepted answer", async () => {
  let attempts = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify({ decision: {
      action: "respond", response: "Accepted answer.",
      ...(++attempts === 1 ? { acknowledgement: "Do not publish." } : {}),
    } }),
    meta: {},
  }));
  const onAcknowledgement = vi.fn();
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", { onAcknowledgement });

  const result = await runRequestRunner(request);

  expect(result.output).toBe("Accepted answer.");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(onAcknowledgement).not.toHaveBeenCalled();
  expect(request.onAnswerToken).toHaveBeenCalledExactlyOnceWith("Accepted answer.");
});
