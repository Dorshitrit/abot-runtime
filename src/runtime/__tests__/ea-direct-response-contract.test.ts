import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ModelGatewayPolicyConfig, ModelStepCalibrationConfig } from "../../model-gateway/types.js";
import { resolveModelStepOutputTokenLimit } from "../../shared/model-step-registry.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import type { ConversationMemoryAuthoringContext } from "../long-term-memory/conversation-authoring/context.js";
import { createRequestSteeringInbox } from "../request/request-steering.js";
import { createExecutionAgentDecisionFormat } from "../steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/parser.js";
import { buildExecutionAgentInput } from "../steps/execution-agent/input.js";
import { resolveDirectResponseOffer } from "../steps/execution-agent/direct-response-policy.js";
import {
  createRootInvalidOutputLedger,
  createRootInvalidOutputRequest,
  INVALID_OUTPUT_MODEL_POLICY,
  INVALID_OUTPUT_RUNNER_CONFIG,
} from "./support/root-invalid-output-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

const directAnswer = JSON.stringify({ decision: { action: "respond", response: "Complete answer." } });
const deferredAnswer = JSON.stringify({ decision: { action: "respond" } });

function respondVariants(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(respondVariants);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties = record.properties as Record<string, unknown> | undefined;
  const action = properties?.action as { enum?: unknown[] } | undefined;
  if (action?.enum?.includes("respond")) return [record];
  return Object.values(record).flatMap(respondVariants);
}

test.each([
  ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["zero", 0],
  ["negative", -1],
  ["fraction", 0.5],
  ["over pilot bound", 1_025],
] as const)("%s limit leaves the legacy schema intact and rejects inline output", (_, limit) => {
  const options = { directResponseMaxLength: limit };
  expect(createExecutionAgentDecisionFormat(options))
    .toEqual(createExecutionAgentDecisionFormat());
  expect(parseExecutionAgentDecisionOutput(directAnswer, options)).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([expect.objectContaining({
      code: "execution_agent_direct_response_unavailable", path: "decision.response",
    })]),
  });
  expect(parseExecutionAgentDecisionOutput(deferredAnswer, options)).toEqual({
    ok: true, decision: { action: "respond" },
  });
});

test("default contracts retain only deferred respond, without accepting an unoffered body", () => {
  const variants = respondVariants(createExecutionAgentDecisionFormat().schema);
  expect(variants).toHaveLength(1);
  expect(variants[0]).toMatchObject({
    additionalProperties: false,
    properties: { action: { enum: ["respond"] } },
    required: ["action"],
  });
  expect(variants[0]!.properties).not.toHaveProperty("response");
  expect(parseExecutionAgentDecisionOutput(deferredAnswer)).toEqual({
    ok: true, decision: { action: "respond" },
  });
  expect(parseExecutionAgentDecisionOutput(directAnswer)).toMatchObject({ ok: false });
});

test("an offered inline branch preserves the exact body and leaves deferred respond available", () => {
  const options = { directResponseMaxLength: 24 };
  const variants = respondVariants(createExecutionAgentDecisionFormat(options).schema);
  expect(variants).toHaveLength(2);
  expect(variants.find((variant) =>
    Object.hasOwn(variant.properties as object, "response"))).toMatchObject({
    properties: { response: { type: "string", minLength: 1, maxLength: 24 } },
    required: ["action", "response"],
  });
  const answer = "  A complete answer.\n";
  expect(parseExecutionAgentDecisionOutput(
    JSON.stringify({ decision: { action: "respond", response: answer } }), options,
  )).toEqual({ ok: true, decision: { action: "respond", response: answer } });
  expect(parseExecutionAgentDecisionOutput(deferredAnswer, options)).toMatchObject({ ok: true });
});

function calibratedPolicy(
  response: ModelStepCalibrationConfig = {},
  decision: ModelStepCalibrationConfig = {},
): ModelGatewayPolicyConfig {
  const baseProfile = INVALID_OUTPUT_MODEL_POLICY.profiles["invalid-output-test"];
  return {
    ...INVALID_OUTPUT_MODEL_POLICY,
    profiles: {
      "invalid-output-test": {
        ...baseProfile,
        supportsThinking: true,
        generation: { temperature: 0.2, reasoningEffort: "medium" },
        calibration: { "execution.decision": decision, "execution.response": response },
      },
      "separate-response": { ...baseProfile, supportsThinking: true },
    },
  };
}

async function assembledOffer(
  modelPolicy: ModelGatewayPolicyConfig,
  responseTimeoutMs = 20_000,
) {
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    throw new Error("Contract tests must not invoke a model.");
  });
  const request = createRootInvalidOutputRequest(invoke, "execution-agent-v1", {
    modelPolicy,
    runnerConfig: {
      ...INVALID_OUTPUT_RUNNER_CONFIG,
      steps: {
        ...INVALID_OUTPUT_RUNNER_CONFIG.steps,
        "execution.response": { timeoutMs: responseTimeoutMs },
      },
    },
  });
  const ledger = await createRootInvalidOutputLedger("execution-agent-v1");
  const head = ledger.current();
  const call = head.state.calls[0]!;
  const offer = resolveDirectResponseOffer(request, head, call);
  const input = buildExecutionAgentInput(request, {
    head,
    call,
    steeringSnapshot: createRequestSteeringInbox({ requestId: request.requestId }).snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: false,
    allowAuditor: false,
  });
  expect(invoke).not.toHaveBeenCalled();
  return { offer, input };
}

const incompatibleCalibrations: readonly {
  name: string;
  calibration: ModelStepCalibrationConfig;
}[] = [
  { name: "generation temperature", calibration: { generation: { temperature: 0.7 } } },
  { name: "context accounting", calibration: { context: { formatTokenAccounting: { mode: "none" } } } },
  { name: "reasoning effort", calibration: { generation: { reasoningEffort: "high" } } },
  { name: "calibration instructions", calibration: { instructions: ["Write answers in short paragraphs."] } },
  { name: "calibration timeout", calibration: { timeoutMs: 25_000 } },
  { name: "selected profile", calibration: { profileId: "separate-response" } },
  { name: "JSON response format", calibration: { format: "json" } },
  { name: "schema response format", calibration: { format: {
    type: "json_schema", name: "custom_answer",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  } } },
];

test.each(incompatibleCalibrations)(
  "$name preserves deferred authoring and rejects an invented inline answer",
  async ({ calibration }) => {
    const { offer, input } = await assembledOffer(calibratedPolicy(calibration));
    expect(offer).toEqual({ reason: "response_configuration" });
    expect(input.contract.directResponseMaxLength).toBeUndefined();
    const variants = respondVariants(input.format.schema);
    expect(variants).toHaveLength(1);
    expect(variants[0]!.properties).not.toHaveProperty("response");
    expect(parseExecutionAgentDecisionOutput(directAnswer, input.contract)).toMatchObject({ ok: false });
    expect(parseExecutionAgentDecisionOutput(deferredAnswer, input.contract)).toMatchObject({ ok: true });
  },
);

test("a runner response timeout mismatch also retains the deferred contract", async () => {
  const { offer, input } = await assembledOffer(calibratedPolicy(), 25_000);
  expect(offer).toEqual({ reason: "response_configuration" });
  expect(respondVariants(input.format.schema)).toHaveLength(1);
});

test("identical nondefault effective calibration still offers inline response", async () => {
  const shared: ModelStepCalibrationConfig = {
    generation: { temperature: 0.5, reasoningEffort: "high" },
    context: { formatTokenAccounting: { mode: "none" } },
    instructions: ["Preserve the user's requested language."],
    timeoutMs: 25_000,
  };
  const { offer, input } = await assembledOffer(calibratedPolicy(shared, shared));
  expect(offer).toEqual({ reason: "eligible", maxLength: 1_024 });
  expect(respondVariants(input.format.schema)).toHaveLength(2);
  expect(parseExecutionAgentDecisionOutput(directAnswer, input.contract)).toMatchObject({ ok: true });
});

test("the intentional JSON-decision versus text-response format difference remains eligible", async () => {
  const { offer, input } = await assembledOffer(calibratedPolicy(
    { format: { type: "text" } }, { format: "json" },
  ));
  expect(offer.reason).toBe("eligible");
  expect(respondVariants(input.format.schema)).toHaveLength(2);
});

test("an unresolved response profile cannot silently enable inline answering", async () => {
  const { offer, input } = await assembledOffer(calibratedPolicy({ profileId: "missing-profile" }));
  expect(offer).toEqual({ reason: "response_configuration" });
  expect(respondVariants(input.format.schema)).toHaveLength(1);
});

test("the shared owner still caps decisions at 2048 output tokens without capping response", () => {
  expect(resolveModelStepOutputTokenLimit("execution.decision")).toBe(2_048);
  expect(resolveModelStepOutputTokenLimit("execution.response")).toBeUndefined();
});


test("direct memory authoring requires its candidate lane and binds proposals to server-owned user evidence", () => {
  const content = "The user prefers concise explanations.";
  const userMessage = "Remember that I prefer concise explanations.";
  const context: ConversationMemoryAuthoringContext = {
    evidence: { sourceSessionId: "session", sourceRequestId: "request",
      observedAt: "2026-10-13T10:00:00.000Z", evidenceDigest: "source-digest" },
    targets: new Map(), userMessages: [userMessage],
    message: { role: "system", content: "{}" },
  };
  const options = { directResponseMaxLength: 1024, directResponseMemoryAuthoring: { context } };
  const directVariant = respondVariants(createExecutionAgentDecisionFormat(options).schema)
    .find((variant) => Object.hasOwn(variant.properties as object, "response"));
  expect(directVariant).toMatchObject({ required: ["action", "response", "memoryCandidates"] });
  const candidate = { content, tags: ["style"], target: null, score: 90,
    reason: "The current user states this preference.", reinforced: true, explicitRequestQuote: userMessage };
  const parsed = parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "respond", response: "Understood.", memoryCandidates: [candidate],
  } }), options);
  expect(parsed).toMatchObject({ ok: true, decision: {
    action: "respond", response: "Understood.", memoryCandidates: [{ content, tags: ["style"],
      assessment: { explicitlyRequested: true, evidence: context.evidence } }],
  } });
  expect(parseExecutionAgentDecisionOutput(directAnswer, options)).toMatchObject({ ok: false });
  expect(parseExecutionAgentDecisionOutput(deferredAnswer, options)).toMatchObject({ ok: true });
  expect(parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "respond", memoryCandidates: [candidate],
  } }), options)).toMatchObject({ ok: false });
  expect(parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "respond", response: "Understood.", memoryCandidates: [candidate],
  } }), { directResponseMaxLength: 1024 })).toMatchObject({ ok: false });
});

test("invalid candidate targets cannot acquire update authority through a direct answer", () => {
  const context: ConversationMemoryAuthoringContext = {
    evidence: { sourceSessionId: "session", sourceRequestId: "request",
      observedAt: "2026-10-13T10:00:00.000Z", evidenceDigest: "source-digest" },
    targets: new Map(), userMessages: ["I prefer short answers."],
    message: { role: "system", content: "{}" },
  };
  expect(parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "respond", response: "Understood.", memoryCandidates: [{
      content: "The user prefers short answers.", tags: [], target: "invented-ref", score: 90,
      reason: "Current input.", reinforced: true, explicitRequestQuote: null,
    }],
  } }), { directResponseMaxLength: 1024, directResponseMemoryAuthoring: { context } }))
    .toMatchObject({ ok: true, decision: { response: "Understood.", memoryCandidates: [] } });
});
