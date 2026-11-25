import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { WorkerCapabilityDescriptor } from "../orchestration/worker-capabilities/index.js";
import {
  createWorkerControlsFusionFixture, FUSION_CAPABILITY, FUSION_GUIDANCE, fusedControlsReply,
} from "./support/worker-controls-fusion-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const selection = {
  action: "invoke_capability", capabilityId: FUSION_CAPABILITY.capabilityId,
  intent: "Observe the requested items.",
};
const ordinaryCapability: WorkerCapabilityDescriptor = {
  ...FUSION_CAPABILITY, capabilityId: "fixture.ordinary", controlsRefinement: undefined,
  controls: {
    type: "object", additionalProperties: false,
    properties: { ordinarySourceKey: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["ordinarySourceKey"],
  },
};

test("one eligible Worker call selects exact controls with its guidance once in system context", async () => {
  const f = await createWorkerControlsFusionFixture([FUSION_CAPABILITY, ordinaryCapability], undefined, 32_768);
  const controls = { query: "runtime research", maxItems: 5 };
  f.invoke.mockImplementation(async (input) => {
    expect(input.modelStep).toBe(MODEL_STEPS.WORKER_DECISION);
    expect(input.format).toMatchObject({ name: "worker_evidence_and_selection_with_controls" });
    const messages = input.messages as readonly ChatMessage[];
    const guidanceMessages = messages.filter(({ content }) => content.includes(FUSION_GUIDANCE));
    expect(guidanceMessages).toHaveLength(1);
    expect(guidanceMessages[0]!.role).toBe("system");
    expect(guidanceMessages[0]!.content.split(FUSION_GUIDANCE)).toHaveLength(2);
    expect(guidanceMessages[0]!.content).toContain(FUSION_CAPABILITY.capabilityId);
    expect(JSON.stringify(input.messages)).not.toContain(`Separate guidance for ${ordinaryCapability.capabilityId}.`);
    expect(JSON.stringify(input.format)).not.toContain("ordinarySourceKey");
    return fusedControlsReply({ ...selection, controls });
  });
  const worker = await f.openWorker();
  const decision = await worker.decide();
  expect(decision).toEqual({ ...selection, controls });
  if (decision.action !== "invoke_capability") throw new Error("expected_invocation");
  await worker.binding.execute(decision);
  expect(f.execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ controls }));
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(f.guidance).toHaveBeenCalledExactlyOnceWith(FUSION_CAPABILITY.capabilityId);
});

test.each([{ query: null, maxItems: null }, {}])("optional controls %j remain omitted for adapter-owned defaults", async (controls) => {
  const f = await createWorkerControlsFusionFixture();
  f.invoke.mockResolvedValue(fusedControlsReply({ ...selection, controls }));
  f.execute.mockImplementation(async ({ controls: accepted }) => ({
    outcome: "succeeded", observedEffect: "observation",
    summary: `Adapter default count: ${accepted.maxItems ?? 12}`,
  }));
  const worker = await f.openWorker();
  const decision = await worker.decide();
  expect(decision).toEqual({ ...selection, controls: {} });
  if (decision.action !== "invoke_capability") throw new Error("expected_invocation");
  await worker.binding.execute(decision);
  expect(f.execute.mock.calls[0]![0].controls).toEqual({});
  expect(f.ledger.current().state.capabilityExecutions[0]?.summary).toBe("Adapter default count: 12");
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("an accepted fused refusal returns to the caller without executing", async () => {
  const f = await createWorkerControlsFusionFixture();
  f.invoke.mockResolvedValue(fusedControlsReply({ action: "return_failure", reason: "The assigned source is unavailable." }));
  const result = await f.invokeWorker();
  expect(result.execution).toMatchObject({ outcome: "failed", summary: "The assigned source is unavailable." });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.ledger.current().state.capabilityExecutions).toEqual([]);
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test.each(["no opt-in", "multiple opted-in capabilities"] as const)("%s keeps guidance in the selected capability's separate controls step", async (scenario) => {
  const capabilities = scenario === "no opt-in"
    ? [{ ...FUSION_CAPABILITY, controlsRefinement: undefined }]
    : [FUSION_CAPABILITY, { ...FUSION_CAPABILITY, capabilityId: "fixture.other" }];
  const f = await createWorkerControlsFusionFixture(capabilities);
  const controls = { query: "runtime research", maxItems: 5 };
  f.invoke.mockImplementation(async (input) => {
    if (input.modelStep === MODEL_STEPS.WORKER_DECISION) {
      expect(input.format).toMatchObject({ name: "worker_evidence_and_selection" });
      expect(JSON.stringify(input.messages)).not.toContain(FUSION_GUIDANCE);
      expect(f.guidance).not.toHaveBeenCalled();
      return fusedControlsReply(selection);
    }
    expect(input.modelStep).toBe(MODEL_STEPS.CAPABILITY_CONTROLS);
    expect(JSON.stringify(input.messages)).toContain(FUSION_GUIDANCE);
    return { text: JSON.stringify({ decision: { action: "invoke_capability", controls } }), meta: {} };
  });
  const worker = await f.openWorker();
  await expect(worker.decide()).resolves.toEqual({ ...selection, controls });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION, MODEL_STEPS.CAPABILITY_CONTROLS,
  ]);
  expect(f.guidance).toHaveBeenCalledExactlyOnceWith(FUSION_CAPABILITY.capabilityId);
});

test("choosing an ordinary capability preserves its separate controls despite offered fusion", async () => {
  const f = await createWorkerControlsFusionFixture([FUSION_CAPABILITY, ordinaryCapability], undefined, 32_768);
  const ordinarySelection = { ...selection, capabilityId: ordinaryCapability.capabilityId };
  const controls = { ordinarySourceKey: "catalog-B" };
  f.invoke.mockImplementation(async (input) => {
    if (input.modelStep === MODEL_STEPS.WORKER_DECISION) {
      expect(input.format).toMatchObject({ name: "worker_evidence_and_selection_with_controls" });
      expect(JSON.stringify(input.messages)).toContain(FUSION_GUIDANCE);
      expect(JSON.stringify(input.messages)).not.toContain(`Separate guidance for ${ordinaryCapability.capabilityId}.`);
      return fusedControlsReply(ordinarySelection);
    }
    expect(input.modelStep).toBe(MODEL_STEPS.CAPABILITY_CONTROLS);
    expect(JSON.stringify(input.messages)).not.toContain(FUSION_GUIDANCE);
    expect(JSON.stringify(input.messages)).toContain(`Separate guidance for ${ordinaryCapability.capabilityId}.`);
    return { text: JSON.stringify({ decision: { action: "invoke_capability", controls } }), meta: {} };
  });
  const worker = await f.openWorker();
  await expect(worker.decide()).resolves.toEqual({ ...ordinarySelection, controls });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION, MODEL_STEPS.CAPABILITY_CONTROLS,
  ]);
  expect(f.guidance.mock.calls.map(([capabilityId]) => capabilityId)).toEqual([
    FUSION_CAPABILITY.capabilityId, ordinaryCapability.capabilityId,
  ]);
});

test("invalid fused controls use structured repair before any execution", async () => {
  const f = await createWorkerControlsFusionFixture(undefined, undefined, 32_768);
  f.invoke.mockResolvedValueOnce(fusedControlsReply({ ...selection, controls: { query: "runtime", maxItems: 99 } }))
    .mockImplementationOnce(async (input) => {
      expect(input.format).toMatchObject({ name: "worker_evidence_and_selection_with_controls" });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.ledger.current().state.capabilityExecutions).toEqual([]);
      return fusedControlsReply({ ...selection, controls: { query: "runtime", maxItems: 5 } });
    });
  const worker = await f.openWorker();
  await expect(worker.decide()).resolves.toEqual({ ...selection, controls: { query: "runtime", maxItems: 5 } });
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION, MODEL_STEPS.WORKER_DECISION,
  ]);
  expect(f.execute).not.toHaveBeenCalled();
});

test("steering received during fused selection discards its controls before execution", async () => {
  const f = await createWorkerControlsFusionFixture();
  f.invoke.mockImplementation(async (input) => {
    expect(input.format).toMatchObject({ name: "worker_evidence_and_selection_with_controls" });
    f.steering.append({ steerId: "changed-assignment", text: "Stop this observation." });
    return fusedControlsReply({ ...selection, controls: { query: "runtime", maxItems: 5 } });
  });
  const result = await f.invokeWorker();
  expect(result.execution).toMatchObject({ outcome: "yielded", steeringVersion: 1 });
  expect(f.ledger.current().state.activeCallId).toBe("call-1");
  expect(f.ledger.current().state.capabilityExecutions).toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("an oversized optional controls context falls back before generating any fused output", async () => {
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const invocation = resolveModelInvocation(input);
    const isFused = typeof input.format === "object" && input.format?.name === "worker_evidence_and_selection_with_controls";
    return { inputTokens: isFused ? 9_000 : 1_000, source: "provider_input_token_count",
      profileId: invocation.profile.id, provider: invocation.profile.provider, model: invocation.model,
      contextWindowTokens: invocation.profile.contextWindowTokens };
  });
  const f = await createWorkerControlsFusionFixture(undefined, countInputTokens);
  const controls = { query: "runtime", maxItems: 5 };
  f.invoke.mockImplementation(async (input) => {
    if (input.modelStep === MODEL_STEPS.WORKER_DECISION) {
      expect(input.format).toMatchObject({ name: "worker_evidence_and_selection" });
      expect(JSON.stringify(input.messages)).not.toContain(FUSION_GUIDANCE);
      return fusedControlsReply(selection);
    }
    expect(input.modelStep).toBe(MODEL_STEPS.CAPABILITY_CONTROLS);
    return { text: JSON.stringify({ decision: { action: "invoke_capability", controls } }), meta: {} };
  });
  const worker = await f.openWorker();
  await expect(worker.decide()).resolves.toEqual({ ...selection, controls });
  expect(countInputTokens.mock.calls.some(([input]) => typeof input.format === "object" &&
    input.format?.name === "worker_evidence_and_selection_with_controls")).toBe(true);
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual([
    MODEL_STEPS.WORKER_DECISION, MODEL_STEPS.CAPABILITY_CONTROLS,
  ]);
  expect(f.execute).not.toHaveBeenCalled();
});
