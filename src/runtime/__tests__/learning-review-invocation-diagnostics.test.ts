import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningKnowledgeEntry } from "../long-term-memory/maturation/contracts.js";
import * as logger from "../observability/debug-logger.js";
import { createLearningReviewInvocation } from "../passive-learning/review-invocation.js";
import type { LearningReviewInput } from "../passive-learning/review-references.js";

const privateScreen = "PRIVATE_SCREEN_391";
const privateKnowledge = "PRIVATE_KNOWLEDGE_572";
const privateProperty = "PRIVATE_PROPERTY_864";
const privateReference = "PRIVATE_UNKNOWN_REFERENCE_109";
const privateOutput = "PRIVATE_MODEL_CONTENT_263";
const correlation = { requestId: "learning:diagnostics-batch", batchId: "diagnostics-batch",
  modelProfileId: "test-profile", contract: "learning_review_decisions_v2", mode: "activity" };

function input(): LearningReviewInput {
  const entries: LearningKnowledgeEntry[] = ["candidate", "candidate", "memory", "memory", "memory"].map((kind, index) => ({
    kind: kind as LearningKnowledgeEntry["kind"], id: `private-record-${index}`, version: `private-version-${index}`,
    content: `${privateKnowledge} ${index}`, tags: [], score: kind === "candidate" ? 45 : null,
    reason: null, certainty: "observed", mutable: index !== 4, lastReinforcedAt: null, reconsiderAt: null,
  }));
  return { batchId: correlation.batchId, modelProfileId: correlation.modelProfileId,
    signal: new AbortController().signal, promotionScore: 80,
    context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
      entries, omitted: 0, referenceTime: "2026-09-25T10:00:00Z" },
    observations: [{ id: "private-observation", deviceId: "private-device", sequence: 1, timestamp: "2026-09-25T10:00:00Z",
      source: { app: "editor", windowId: "private-window" }, content: privateScreen,
      kind: "view", extraction: "uia", coverage: "partial" }],
  };
}
function create(changes: Record<string, unknown> = {}) {
  return { action: "create", content: privateOutput, tags: [], score: 45,
    reason: "Observed useful evidence.", certainty: "observed", reconsiderAt: null, evidence: ["o1"], ...changes };
}
function expectPrivateDiagnostics() {
  const emitted = JSON.stringify(vi.mocked(logger.traceDebug).mock.calls);
  for (const marker of [privateScreen, privateKnowledge, privateProperty, privateReference, privateOutput,
    "private-record-", "private-version-", "private-observation", "private-device", "private-window"])
    expect(emitted).not.toContain(marker);
}
beforeEach(() => { vi.spyOn(logger, "traceDebug").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("content-free learning invocation diagnostics", () => {
  it("records the prepared contract and exact counts without logging messages or schema", () => {
    const invocation = createLearningReviewInvocation(input());
    expect(logger.traceDebug).toHaveBeenCalledExactlyOnceWith("runtime.passive_learning", "review.prepared", {
      ...correlation, observationCount: 1, knowledgeCount: 5, mutableTargetCount: 4, protectedCount: 1,
      inputCharacters: invocation.messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0),
      schemaCharacters: JSON.stringify(invocation.format.schema).length,
    });
    expectPrivateDiagnostics();
  });

  it("accepts canonical decisions and records only fixed action counts", () => {
    const invocation = createLearningReviewInvocation(input());
    const text = JSON.stringify({ decisions: [create(),
      create({ action: "update", target: "k1", reinforced: false }),
      create({ action: "merge", target: "k3", sources: ["k2"], reinforced: true }),
      { action: "remove", target: "k4", reason: "No longer relevant.", evidence: ["o1"] },
    ] });
    const decisions = invocation.accept(text);
    expect(decisions).toHaveLength(4);
    expect(decisions[2]).toMatchObject({ targetKind: "memory", targetId: "private-record-2",
      targetVersion: "private-version-2", mergedCandidateIds: ["private-record-1"], observationIds: ["private-observation"] });
    expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "review.output_accepted", {
      ...correlation, outputCharacters: text.length, decisionCount: 4, actionCounts: { create: 1, update: 1, merge: 1, remove: 1 },
    });
    expect(logger.traceDebug).toHaveBeenCalledTimes(2);
    expectPrivateDiagnostics();
  });

  it.each([
    { name: "envelope", text: JSON.stringify({ [privateProperty]: privateOutput }), reason: "learning_output_decisions_missing",
      details: { stage: "envelope", rootType: "object", decisionsType: "missing", decisionLimit: 12 } },
    { name: "shape", decision: create({ [privateProperty]: privateOutput }), reason: "learning_review_output_contract_invalid",
      details: { stage: "shape", decisionIndex: 1, action: "create" } },
    { name: "target", decision: { action: "remove", target: privateReference, reason: privateOutput, evidence: ["o1"] },
      reason: "learning_decision_target_unknown", details: { stage: "target_binding", decisionIndex: 1, action: "remove" } },
    { name: "evidence", decision: create({ evidence: [privateReference] }), reason: "learning_decision_source_unknown",
      details: { stage: "evidence_binding", decisionIndex: 1, action: "create" } },
    { name: "domain", decision: create({ content: "" }), reason: "learning_content_invalid",
      details: { stage: "domain_validation", decisionIndex: 1, action: "create" } },
    { name: "unknown action", decision: create({ action: privateReference }), reason: "learning_action_invalid",
      details: { stage: "shape", decisionIndex: 1, action: "unknown" } },
    { name: "protected target", decision: { action: "remove", target: "k5", reason: privateOutput, evidence: ["o1"] },
      reason: "learning_memory_protected", details: { stage: "target_binding", decisionIndex: 1, action: "remove" } },
  ])("correlates a $name rejection using bounded diagnostic fields only", ({ text, decision, reason, details }) => {
    const invocation = createLearningReviewInvocation(input());
    const response = text ?? JSON.stringify({ decisions: [create(), decision] });
    expect(() => invocation.accept(response)).toThrow(reason);
    expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "review.output_rejected", {
      ...correlation, outputCharacters: response.length, reason, ...details,
    });
    expect(logger.traceDebug).toHaveBeenCalledTimes(2);
    expectPrivateDiagnostics();
  });

  it("marks scheduled reviews separately and records a successful no-change response", () => {
    const original = input();
    const { kind, id, version } = original.context.entries[0]!;
    const invocation = createLearningReviewInvocation({ ...original, observations: [],
      cause: { kind: "scheduled_knowledge_review", dueEntries: [{ kind, id, version }] } });
    expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "review.prepared", expect.objectContaining({
      ...correlation, mode: "scheduled", observationCount: 0, mutableTargetCount: 1, protectedCount: 1,
    }));
    const text = '{"decisions":[]}';
    expect(invocation.accept(text)).toEqual([]);
    expect(logger.traceDebug).toHaveBeenLastCalledWith("runtime.passive_learning", "review.output_accepted", {
      ...correlation, mode: "scheduled", outputCharacters: text.length, decisionCount: 0,
      actionCounts: { create: 0, update: 0, merge: 0, remove: 0 },
    });
    expectPrivateDiagnostics();
  });
});
