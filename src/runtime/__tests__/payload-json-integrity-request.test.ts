import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestExecutionSeed } from "../request/contracts.js";
import { createRequestWorkerCapabilityPayloadAuthor } from "../request/worker-capability-payload.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";

const format = {
  type: "object", additionalProperties: false,
  properties: { label: { type: "string" }, count: { type: "integer" } },
  required: ["label", "count"],
};
const duplicate = '{"label":"discarded","label":"kept","count":1}';
const valid = '{ "label": "kept", "count": 1 }';

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function fixture(outputs: readonly string[], structured = true) {
  let next = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    const text = outputs[next++];
    if (text === undefined) throw new Error("unexpected_model_call");
    return { text, meta: {} };
  });
  const requestId = "payload-json-integrity";
  const request = createTestRequestExecutionScope({
    requestId, sessionId: `${requestId}-session`, prompt: "Produce the requested payload.",
    historyMessages: [], shouldGenerateSessionTitle: false, agentMode: "reasoning",
    runnerConfig: {
      models: { defaults: { profileId: "payload-test", steps: {} } },
      context: { outputReserveTokens: 1_000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: { "tool_payload.raw": { timeoutMs: 20_000 } } as RequestExecutionSeed["runnerConfig"]["steps"],
    },
    modelPolicy: {
      providers: { "payload-provider": { type: "ollama" } },
      profiles: { "payload-test": { provider: "payload-provider", model: "fixture", contextWindowTokens: 16_000 } },
      defaults: { profileId: "payload-test", steps: { "tool_payload.raw": "toolPayload.raw" } },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    toolPermissionMode: "full_access", abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  });
  const author = createRequestWorkerCapabilityPayloadAuthor(request, ["root"]);
  return {
    invoke,
    run: () => author.author({
      call: {
        callId: "call-1", parentCallId: null, roleId: "supervisor", depth: 0, objective: null,
        dependencyResultRefs: [], status: "active", childCallIds: [], activationCount: 1, resultRef: null,
      },
      executionId: "capability-execution-1",
      descriptor: {
        capabilityId: "neutral_payload", summary: "Submit a complete payload.", effect: "mutation",
        requiresPayloadAuthoringObjective: true,
        controls: { type: "object", additionalProperties: false, properties: {}, required: [] },
      },
      controls: {}, authoringObjective: "Produce the requested payload.", settledCapabilityResults: [],
      requestSteering: { kind: "request_steering_v1", version: 0, updates: [] },
      contract: {
        instructions: "Produce the requested payload.", minBytes: 1, maxBytes: 4_096,
        ...(structured ? { responseFormat: format } : {}),
      },
      ...(structured ? { stage: { index: 1, count: 1, outputParam: "body" } } : {}),
    }),
  };
}

describe("request payload member integrity", () => {
  it.each([
    { label: "duplicate member", output: duplicate },
    { label: "malformed JSON", output: "not json" },
    { label: "schema-invalid JSON", output: '{"label":"kept","count":"one"}' },
  ])("uses the existing bounded validation path for $label", async ({ output }) => {
    const { invoke, run } = fixture([output, valid]);
    await expect(run()).resolves.toEqual({ status: "authored", body: '{"label":"kept","count":1}' });
    expect(invoke).toHaveBeenCalledTimes(2);
    const initial = invoke.mock.calls[0]![0];
    const repair = invoke.mock.calls[1]![0];
    expect(repair.format).toEqual(initial.format);
    const repairMessages = repair.messages as readonly ChatMessage[];
    expect(repairMessages.slice(0, -1)).toEqual(initial.messages);
    expect(JSON.stringify(repairMessages.at(-1))).toContain("payload_model_output_invalid");
  });

  it("rejects repeated duplicate payloads after exactly the existing repair budget", async () => {
    const { invoke, run } = fixture([duplicate, duplicate, duplicate]);
    await expect(run()).resolves.toEqual({ status: "failed", code: "payload_model_output_invalid" });
    expect(invoke).toHaveBeenCalledTimes(3);
    for (const [request] of invoke.mock.calls.slice(1)) {
      expect(JSON.stringify(request.messages)).not.toContain("discarded");
    }
  });

  it("leaves valid structured and raw payloads on one-call paths", async () => {
    const structured = fixture([valid]);
    await expect(structured.run()).resolves.toEqual({ status: "authored", body: '{"label":"kept","count":1}' });
    expect(structured.invoke).toHaveBeenCalledOnce();
    const raw = fixture([duplicate], false);
    await expect(raw.run()).resolves.toEqual({ status: "authored", body: duplicate });
    expect(raw.invoke).toHaveBeenCalledOnce();
  });
});
