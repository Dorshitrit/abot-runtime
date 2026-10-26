import { expect, test } from "vitest";
import { buildOpenAIInputTokenCountPayload } from "../../model-gateway/providers/openai/payload.js";
import { generateSemanticCompactionCandidateBatched } from "../context/semantic-compaction/index.js";
import { buildMinimalSemanticCompactionInstructions } from "../context/semantic-compaction/minimal-instructions.js";
import { resolveSemanticCompactionInstructions } from "../context/semantic-compaction/execution-evidence-instructions.js";
import { SEMANTIC_COMPACTION_INSTRUCTIONS } from "../context/semantic-compaction/prompt.js";
import {
  semanticContractFixture,
  readCompactionEnvelope,
  COMPACTION_FACT,
  CONFIGURED_COMPACTION_GUIDANCE,
  CALIBRATED_COMPACTION_GUIDANCE,
} from "./support/semantic-compaction-contract-fixture.js";

const projectionRepair = Object.freeze({
  reason: "projection_not_reduced" as const,
  originalInputTokens: 12000,
  candidateInputTokens: 12300,
  targetInputTokens: 11000,
});

test.each([false, true])("EA projection repair isolates batch/slice instructions and keeps source/schema bindings (%s)", async (sliced) => {
  const fixture = semanticContractFixture({ policy: "execution-agent-v1", sliced });
  const originalPolicy = structuredClone(fixture.params.request.modelPolicy);
  const candidate = await generateSemanticCompactionCandidateBatched({
    ...fixture.params,
    projectionRepair,
  });
  expect(candidate.continuation.currentState).toBe(COMPACTION_FACT);
  expect(candidate.sourceDigests).toEqual([expect.objectContaining({
    sourceRef: fixture.source.sourceRef,
    sourceFingerprint: fixture.source.sourceFingerprint,
  })]);
  expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
  expect(fixture.params.request.modelPolicy).toEqual(originalPolicy);
  const envelopes = fixture.captured.map(readCompactionEnvelope);
  for (const messages of fixture.captured) {
    // Verify instruction-owner selection and exact authority data, not prompt wording.
    expect(messages[0]?.content).toContain(buildMinimalSemanticCompactionInstructions(projectionRepair));
    expect(messages[0]?.content).not.toContain(resolveSemanticCompactionInstructions(["execution.decision"]));
    const envelope = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    expect(envelope.currentRequest).toBe(fixture.params.request.prompt);
    expect(envelope.active).toEqual({
      roleId: fixture.params.binding.roleId,
      callId: fixture.params.binding.callId,
      preservationObjective: fixture.params.preservationObjective,
      allowedConsumers: fixture.params.binding.allowedConsumers,
    });
  }
  for (const [input] of fixture.invoke.mock.calls) {
    expect(input.format).toMatchObject({ type: "json_schema", calibrationInstructions: "omit" });
  }
  const countPayloads = fixture.countInputTokens.mock.calls
    .map(([input]) => input)
    .filter(({ modelStep }) => modelStep === "context.compact")
    .map(buildOpenAIInputTokenCountPayload);
  expect(countPayloads.length).toBeGreaterThan(0);
  for (const payload of [...countPayloads, ...fixture.providerPayloads]) {
    expect(JSON.stringify(payload)).not.toContain(CONFIGURED_COMPACTION_GUIDANCE);
    expect(JSON.stringify(payload)).not.toContain(CALIBRATED_COMPACTION_GUIDANCE);
    expect(JSON.stringify(payload)).not.toContain("calibrationInstructions");
    expect(payload).not.toHaveProperty("text");
    expect(payload.tools).toEqual([expect.objectContaining({
      type: "function", name: "context_compaction", strict: true,
      parameters: expect.objectContaining({ type: "object" }),
    })]);
    expect(payload.tool_choice).toEqual({ type: "function", name: "context_compaction" });
  }
  if (!sliced) {
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.newSources).toEqual([expect.objectContaining({
      sourceKey: "source_0",
      sourceRef: fixture.source.sourceRef,
      content: fixture.source.content,
    })]);
    return;
  }
  expect(envelopes.length).toBeGreaterThan(1);
  expect(envelopes.map(({ sourceSlice }) => sourceSlice!.content).join("")).toBe(fixture.source.content);
  expect(envelopes.slice(1).every(({ partialSourceFold }) => partialSourceFold !== undefined)).toBe(true);
});

test("ordinary non-EA semantic instruction owner is unchanged", () => {
  expect(resolveSemanticCompactionInstructions(["worker.decision"])).toBe(SEMANTIC_COMPACTION_INSTRUCTIONS);
  expect(resolveSemanticCompactionInstructions(["execution.decision", "worker.decision"])).toBe(SEMANTIC_COMPACTION_INSTRUCTIONS);
});
