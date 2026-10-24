import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { resolveModelInvocation } from "../../model-gateway/invocation-policy.js";
import { resolveConfiguredStepInstructionMetadata } from "../config/runner/step-instructions.js";
import { invokeModelStep } from "../model/invoke-step.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { StructuredModelInvalidOutputError } from "../model/invoke-structured-step.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import {
  buildSupervisorProcedureGateInput, createSupervisorProcedureGateFormat,
  parseSupervisorProcedureGateOutput, runSupervisorProcedureGate,
} from "../steps/supervisor-decision/procedure-gate.js";
import { createMemoryRecallHarness, modelMessages } from "./support/memory-recall-runner.js";
import { buildSupervisorDelegationInput } from "../steps/supervisor-decision/delegation-input.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => { resetDebugLoggerConfig(); vi.restoreAllMocks(); });

const envelope = (decision: unknown) => JSON.stringify({ decision });
const required = { requiresProcedure: true };
const answer = { requiresProcedure: false, responseRecommendation: "Give the requested explanation." };
const methodology = "CONFIGURED_ROUTING_GUIDANCE_SENTINEL";

function fixture(options: {
  capacity?: number; prompt?: string; methodology?: string;
  countInputTokens?: ModelGatewayClient["countInputTokens"];
} = {}) {
  const h = createMemoryRecallHarness({ policy: "supervisor-worker-v1", decide: () => required });
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: envelope(required), meta: {} }));
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>();
  const store = { list: vi.fn(() => []), read: vi.fn(() => undefined) };
  const request = createRequestExecutionScope({
    seed: {
      ...h.request,
      runnerConfig: { ...h.request.runnerConfig, steps: {
        ...h.request.runnerConfig.steps,
        "supervisor.decision": {
          ...h.request.runnerConfig.steps["supervisor.decision"]!,
          ...(options.methodology ? { instructionBlocks: [{
            ref: "configured-routing.md", content: options.methodology, contentHash: "routing-hash",
          }] } : {}),
        },
      } },
      prompt: options.prompt ?? "  Save the supplied content.\n",
      historyMessages: [{ id: "old-user", role: "user", content: "HISTORY_SENTINEL", createdAt: "2026-10-01T00:00:00.000Z" }],
      attachments: [{ id: "attachment", kind: "image", mimeType: "image/png", data: "aW1hZ2U=", storageRef: "ATTACHMENT_SENTINEL" }],
      modelPolicy: {
        ...h.request.modelPolicy!,
        profiles: { test: { ...h.request.modelPolicy!.profiles!.test!, contextWindowTokens: options.capacity ?? 32_000 } },
      },
      modelGatewayClient: { invoke, invokeRaw, ...(options.countInputTokens ? { countInputTokens: options.countInputTokens } : {}) },
    },
    executionPolicy: h.request.executionPolicy, knowledgeSkillStore: store,
    createWorkerCapabilities: () => h.request.workerCapabilities.provider,
  });
  const diagnostic = { requestId: request.requestId, modelStep: "supervisor.decision" as const };
  return { ...h, request, diagnostic, invoke, invokeRaw, store };
}

test.each([required, answer, { ...answer, responseRecommendation: "x".repeat(300) }])(
  "accepts only the bounded gate variants: %j", (decision) => {
    const parsed = parseSupervisorProcedureGateOutput(envelope(decision));
    expect(parsed).toEqual({ ok: true, decision });
    if (parsed.ok) expect(Object.isFrozen(parsed.decision)).toBe(true);
    expect(validateJsonSchemaValue(createSupervisorProcedureGateFormat(), { decision })).toBeUndefined();
  },
);

test.each([
  "not json", "null", "[]", JSON.stringify(required),
  JSON.stringify({ decision: required, extra: true }),
  envelope({}), envelope({ requiresProcedure: "true" }), envelope({ requiresProcedure: 1 }),
  envelope({ ...required, responseRecommendation: "Not allowed" }),
  envelope({ ...required, action: "respond" }),
  envelope({ ...answer, roleId: "worker" }),
])("rejects invalid gate output %s", (text) => {
  expect(parseSupervisorProcedureGateOutput(text)).toMatchObject({
    ok: false, stage: "domain_parser", issues: [{ code: "supervisor_procedure_gate_invalid" }],
  });
});

test.each([undefined, null, "", "   ", "x".repeat(301), 123])(
  "drops invalid advisory content without rejecting a valid direct response: %j", async (recommendation) => {
    const decision = { requiresProcedure: false, responseRecommendation: recommendation };
    expect(parseSupervisorProcedureGateOutput(envelope(decision)))
      .toEqual({ ok: true, decision: { requiresProcedure: false } });
    const f = fixture();
    f.invoke.mockResolvedValue({ text: envelope(decision), meta: {} });
    await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic }))
      .resolves.toEqual({ decision: { requiresProcedure: false }, steeringVersion: 0 });
    expect(f.invoke).toHaveBeenCalledOnce();
  },
);

test("the provider projection retains the two variants with domain-validated recommendation bounds", () => {
  const format = createSupervisorProcedureGateFormat();
  expect(format.strict).toBe(true);
  expect(() => toOllamaFormat(format)).not.toThrow();
  expect(validateJsonSchemaValue(format, { decision: { ...required, responseRecommendation: "extra" } })).toBeDefined();
  expect(validateJsonSchemaValue(format, { decision: { ...answer, responseRecommendation: "x".repeat(301) } })).toBeDefined();
  expect(parseSupervisorProcedureGateOutput(envelope({ ...answer, responseRecommendation: "  Answer briefly.  " })))
    .toEqual({ ok: true, decision: { requiresProcedure: false, responseRecommendation: "Answer briefly." } });
});

test("projects only instructions and the exact current request, excluding history and attachments", () => {
  const f = fixture();
  const input = buildSupervisorProcedureGateInput(f.request, { diagnostic: f.diagnostic });
  expect(input.modelStep).toBe("supervisor.decision");
  expect(input.context.messages).toHaveLength(2);
  expect(input.context.messages[0]!.role).toBe("system");
  expect(input.context.messages[1]).toEqual({ role: "user", content: f.request.prompt });
  expect(input.context.selectedHistoryMessageIds).toEqual([]);
  expect(input.context.budget.parts.selectedHistoryInputTokens).toBe(0);
  expect(input.context.budget.parts.referenceInputTokens).toBe(0);
  expect(JSON.stringify(input.context.messages)).not.toContain("SENTINEL");
  expect(f.store.list).not.toHaveBeenCalled();
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.memory.retrieve).not.toHaveBeenCalled();
  expect(f.getAdapters).not.toHaveBeenCalled();
});

test.each([required, answer])("invokes the existing decision step and captures the accepted steering version", async (decision) => {
  const f = fixture();
  f.invoke.mockResolvedValue({ text: envelope(decision), meta: {} });
  const expected = buildSupervisorProcedureGateInput(f.request, { diagnostic: f.diagnostic });
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic, boundSteeringVersion: 0 }))
    .resolves.toEqual({ decision, steeringVersion: 0 });
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls[0]![0]).toMatchObject({
    modelStep: "supervisor.decision", messages: expected.context.messages, format: expected.format,
  });
  expect(f.invokeRaw).not.toHaveBeenCalled();
  expect(f.getAdapters).not.toHaveBeenCalled();
});

test("uses the existing repair flow, then returns only an accepted decision", async () => {
  const f = fixture({ methodology });
  f.invoke.mockResolvedValueOnce({ text: envelope({ requiresProcedure: "true" }), meta: {} });
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic }))
    .resolves.toEqual({ decision: required, steeringVersion: 0 });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.invoke.mock.calls[1]![0].modelStep).toBe("supervisor.decision");
  for (const [input] of f.invoke.mock.calls) expect(JSON.stringify(input.messages)).not.toContain(methodology);
  expect(f.getAdapters).not.toHaveBeenCalled();
});

test("exhausted malformed output remains a typed failure, never a default boolean", async () => {
  const f = fixture();
  f.invoke.mockResolvedValue({ text: envelope({ requiresProcedure: "false" }), meta: {} });
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic }))
    .rejects.toBeInstanceOf(StructuredModelInvalidOutputError);
  expect(f.invoke).toHaveBeenCalledTimes(3);
});

test("exact retention rejects an oversized input before provider dispatch or compaction", async () => {
  const f = fixture({ capacity: 1500, prompt: "Required input ".repeat(3000) });
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic }))
    .rejects.toThrow("request_context_final_envelope_exceeds_window");
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.invokeRaw).not.toHaveBeenCalled();
});

test("provider failures propagate without being interpreted as a gate decision", async () => {
  const f = fixture();
  const failure = new Error("fixture_provider_failure");
  f.invoke.mockRejectedValue(failure);
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic })).rejects.toBe(failure);
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("cancellation before invocation never dispatches a model call", async () => {
  const f = fixture();
  const cancelled = new Error("fixture_cancelled");
  f.abortController.abort(cancelled);
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic })).rejects.toBe(cancelled);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("a stale bound steering version is rejected before dispatch", async () => {
  const f = fixture();
  expect(f.requestSteering.append({ steerId: "new-request", text: "Only explain it." }).ok).toBe(true);
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic, boundSteeringVersion: 0 }))
    .rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("steering arriving during a bound gate cannot be accepted", async () => {
  const f = fixture();
  f.invoke.mockImplementation(async () => {
    expect(f.requestSteering.append({ steerId: "change", text: "Only explain it." }).ok).toBe(true);
    return { text: envelope(required), meta: {} };
  });
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic, boundSteeringVersion: 0 }))
    .rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
  expect(f.invoke).toHaveBeenCalledOnce();
});

test("an unbound gate re-evaluates new steering through the shared invocation lifecycle", async () => {
  const f = fixture({ methodology });
  f.invoke.mockImplementationOnce(async () => {
    f.requestSteering.append({ steerId: "change", text: "Only explain it." });
    return { text: envelope(required), meta: {} };
  });
  f.invoke.mockResolvedValue({ text: envelope(answer), meta: {} });
  await expect(runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic }))
    .resolves.toEqual({ decision: answer, steeringVersion: 1 });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.invoke.mock.calls[1]![0].messages)).toContain("Only explain it.");
  for (const [input] of f.invoke.mock.calls) expect(JSON.stringify(input.messages)).not.toContain(methodology);
});

test("configured routing guidance cannot consume the gate budget or enter its provider envelope", async () => {
  const plain = fixture({ capacity: 4_000 });
  const configured = fixture({ capacity: 4_000, methodology: methodology.repeat(2_000) });
  const plainInput = buildSupervisorProcedureGateInput(plain.request, { diagnostic: plain.diagnostic });
  const input = buildSupervisorProcedureGateInput(configured.request, { diagnostic: configured.diagnostic });
  expect(input.context.budget).toEqual(plainInput.context.budget);
  expect(input.context.budget.configuredInstructionReserveTokens).toBeUndefined();
  expect(input.context.messages).toEqual(plainInput.context.messages);
  const metadataInput = {
    runnerConfig: configured.request.runnerConfig, modelStep: "supervisor.decision" as const,
  };
  expect(resolveConfiguredStepInstructionMetadata({ ...metadataInput, configuredInstructionPolicy: "omit" }))
    .toEqual({ blockCount: 0, characterCount: 0, refs: [], contentHashes: [] });
  expect(resolveConfiguredStepInstructionMetadata(metadataInput)).toMatchObject({ blockCount: 1 });
  await expect(runSupervisorProcedureGate(configured.request, { diagnostic: configured.diagnostic }))
    .resolves.toEqual({ decision: required, steeringVersion: 0 });
  expect(configured.invoke).toHaveBeenCalledOnce();
  expect(configured.invoke.mock.calls[0]![0].messages).toEqual(plainInput.context.messages);
  expect(configured.invokeRaw).not.toHaveBeenCalled();
});

test("provider token counting sees the same isolated gate envelope as dispatch", async () => {
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async (input) => {
    const invocation = resolveModelInvocation(input);
    return {
      inputTokens: 170, profileId: invocation.profile.id, provider: invocation.profile.provider,
      model: invocation.model, contextWindowTokens: invocation.profile.contextWindowTokens,
      source: "provider_input_token_count",
    };
  });
  const f = fixture({ methodology, countInputTokens });
  await runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic });
  expect(countInputTokens).toHaveBeenCalledOnce();
  expect(countInputTokens.mock.calls[0]![0].messages).toEqual(f.invoke.mock.calls[0]![0].messages);
  expect(JSON.stringify(countInputTokens.mock.calls[0]![0].messages)).not.toContain(methodology);
});

test.each([
  ["delegation", buildSupervisorDelegationInput], ["legacy routing", buildSupervisorDecisionInput],
] as const)("keeps configured guidance and its reserve in %s after the isolated gate", async (_phase, buildInput) => {
  const f = fixture({ methodology });
  await runSupervisorProcedureGate(f.request, { diagnostic: f.diagnostic });
  const input = buildInput(f.request, {
    diagnostic: f.diagnostic, toolResults: { sourceRevision: 0, results: [] }, allowedRoleIds: ["worker"],
  });
  expect(input.context.budget.configuredInstructionReserveTokens).toBeGreaterThan(0);
  await invokeModelStep({
    request: f.request, modelStep: input.modelStep, messages: input.context.messages, format: input.format,
    contextRetention: "exact", timeoutReason: "fixture_timeout", accept: () => true,
  });
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.invoke.mock.calls[0]![0].messages)).not.toContain(methodology);
  const providerMessages = modelMessages(f.invoke.mock.calls[1]![0]);
  expect(JSON.stringify(providerMessages).split(methodology)).toHaveLength(2);
  expect(providerMessages.filter(({ role, content }) => role === "user" && content === f.request.prompt)).toHaveLength(1);
});
