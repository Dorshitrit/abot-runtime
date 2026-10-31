import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { projectOllamaFormat, projectOpenAIResponsesFormat } from "../../model-gateway/structured-output.js";
import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";
import type { ModelGatewayClient } from "../ports.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import {
  parseWorkerEvidenceAssessmentOutput,
  runWorkerEvidenceAssessment,
} from "../steps/worker-decision/evidence-assessment.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { createSuperCompactionSourceFixture } from "./support/super-compaction-source.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each([false, true])("projects the production evidence format with settled evidence=%s", async (withEvidence) => {
  const base = await createSuperCompactionSourceFixture("worker-evidence-provider-contract");
  const evidenceRefs = withEvidence ? ["capability-execution-1"] : [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({
    text: JSON.stringify({ decision: {
      requiresExecution: true,
      established: "Only the supplied evidence is established.",
      remaining: "Finish the assigned work.",
      evidenceRefs,
    } }),
    meta: {},
  }));
  const request = deriveTestRequestExecutionScope(base.request, {
    runnerConfig: {
      ...base.request.runnerConfig,
      steps: { ...base.request.runnerConfig.steps, [MODEL_STEPS.WORKER_EVIDENCE]: { timeoutMs: 20_000 } },
    },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
  });
  const capabilitySource = withEvidence ? {
    ledger: base.ledger,
    head: base.head,
    binding: Object.freeze({
      requestId: request.requestId,
      ledger: base.ledger,
      callId: base.call.callId,
      invocationAttempt: base.call.activationCount,
      capabilities: Object.freeze([]),
    }),
  } : undefined;
  const input = buildWorkerDecisionInput(request, {
    call: base.call,
    requestToolResults: withEvidence ? base.view : Object.freeze({
      sourceRevision: base.head.revision,
      results: Object.freeze([]),
    }),
    ...(capabilitySource ? { capabilitySource } : {}),
  });

  await runWorkerEvidenceAssessment(request, {
    call: base.call,
    source: input.resultAuthorSource,
    contextMessages: input.sharedContextMessages,
    ...(capabilitySource ? { capabilitySource } : {}),
  });

  expect(invoke).toHaveBeenCalledOnce();
  const invocation = invoke.mock.calls[0]![0];
  expect(invocation.modelStep).toBe(MODEL_STEPS.WORKER_EVIDENCE);
  const format = invocation.format as ModelGatewayJsonSchemaFormat;
  const canonical = structuredClone(format);
  const projected = projectOllamaFormat(format);
  const expectedSchema = structuredClone(format.schema) as {
    properties: { decision: { properties: {
      established: { maxLength?: number };
      remaining: { maxLength?: number };
      evidenceRefs: { maxItems: number; items: { enum?: string[] } };
    } } };
  };
  delete expectedSchema.properties.decision.properties.established.maxLength;
  delete expectedSchema.properties.decision.properties.remaining.maxLength;
  expect(projected.format).toEqual(expectedSchema);
  expect(projected.diagnostics.map(({ path }) => path)).toEqual([
    "/properties/decision/properties/established/maxLength",
    "/properties/decision/properties/remaining/maxLength",
  ]);
  const refsSchema = expectedSchema.properties.decision.properties.evidenceRefs;
  expect(refsSchema.maxItems).toBe(evidenceRefs.length);
  expect(refsSchema.items.enum).toEqual(withEvidence ? evidenceRefs : undefined);
  expect(projectOpenAIResponsesFormat(format).format).toMatchObject({ schema: format.schema });
  expect(format).toEqual(canonical);
});

test.each([
  { establishedLength: 2_000, remainingLength: 1_000, accepted: true },
  { establishedLength: 2_001, remainingLength: 1_000, accepted: false },
  { establishedLength: 2_000, remainingLength: 1_001, accepted: false },
])("post-validates evidence text bounds: $establishedLength/$remainingLength", ({
  establishedLength, remainingLength, accepted,
}) => {
  const result = parseWorkerEvidenceAssessmentOutput(JSON.stringify({ decision: {
    requiresExecution: true,
    established: "e".repeat(establishedLength),
    remaining: "r".repeat(remainingLength),
    evidenceRefs: [],
  } }), []);
  expect(result.ok).toBe(accepted);
});
