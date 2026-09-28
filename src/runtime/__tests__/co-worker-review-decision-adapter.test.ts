import { describe, expect, test } from "vitest";
import type { LearningKnowledgeEntry } from "../long-term-memory/maturation/contracts.js";
import { LearningDecisionEnvelopeError } from "../long-term-memory/maturation/decision-envelope.js";
import { createLearningReviewFormat } from "../passive-learning/review-response-format.js";
import { decodeLearningReviewDecisions, LearningReviewOutputError } from "../passive-learning/review-decision-adapter.js";
import type { LearningReviewReferences } from "../passive-learning/review-references.js";

function entry(id: string, changes: Partial<LearningKnowledgeEntry> = {}): LearningKnowledgeEntry {
  return { kind: "candidate", id, version: "7", content: "Prefers focused project reviews", tags: ["work"],
    score: 40, reason: "Repeated evidence", certainty: "observed", mutable: true,
    lastReinforcedAt: null, reconsiderAt: null, ...changes };
}
function references(scheduled = false): LearningReviewReferences {
  const entries = [entry("candidate-one"), entry("candidate-two"),
    entry("protected-memory", { kind: "memory", mutable: false }),
    entry("mutable-memory", { kind: "memory", score: null, certainty: "unspecified" })];
  return {
    context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 9,
      knowledgeRevision: 9, entries, omitted: 0, referenceTime: "2026-09-25T16:00:00.000Z" },
    ...(scheduled ? { cause: { kind: "scheduled_knowledge_review" as const,
      dueEntries: [{ kind: "candidate" as const, id: "candidate-one", version: "7" }] } } : {}),
    knowledge: new Map(entries.map((value, index) => [`k${index + 1}`, value])),
    evidence: new Map(scheduled ? [] : [["e1", "observation-one"], ["e2", "observation-two"]]),
    observationIds: scheduled ? [] : ["observation-one", "observation-two"],
    targetRefs: scheduled ? ["k1"] : ["k1", "k2", "k4"], mergeRefs: scheduled ? [] : ["k1", "k2"], scheduled,
  };
}
const content = { content: "  Prefers focused reviews  ", tags: ["work"], score: 45,
  reason: "Repeated independent evidence", certainty: "inferred", reconsiderAt: null };
function creation() { return { action: "create", ...content, evidence: ["e1"] }; }
function update() { return { action: "update", target: "k1", ...content, evidence: ["e2"], reinforced: true }; }
function decode(decisions: readonly unknown[], refs = references()) {
  return decodeLearningReviewDecisions(JSON.stringify({ decisions }), refs, createLearningReviewFormat(refs));
}
function rejection(raw: unknown, refs = references()): LearningReviewOutputError {
  try { decode([raw], refs); } catch (error) {
    expect(error).toBeInstanceOf(LearningReviewOutputError);
    return error as LearningReviewOutputError;
  }
  throw new Error("Expected strict adapter rejection");
}

describe("strict learning review decision adapter", () => {
  test("creates only fresh candidates and resolves exact evidence without model-owned identity", () => {
    const [decision] = decode([creation()]);
    expect(decision).toEqual({ action: "create", content: "Prefers focused reviews", tags: ["work"], score: 45,
      reason: content.reason, certainty: "inferred", reconsiderAt: null,
      targetKind: "candidate", targetId: null, targetVersion: null,
      observationIds: ["observation-one"], reinforced: false, mergedCandidateIds: [] });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  test("materializes exact target identity/version and merge sources from this review", () => {
    const [updated] = decode([update()]);
    expect(updated).toMatchObject({ action: "update", targetKind: "candidate", targetId: "candidate-one", targetVersion: "7",
      observationIds: ["observation-two"], reinforced: true, mergedCandidateIds: [] });
    const [merged] = decode([{ ...update(), action: "merge", sources: ["k2"] }]);
    expect(merged).toMatchObject({ action: "merge", targetId: "candidate-one", mergedCandidateIds: ["candidate-two"] });
    const [memoryMerge] = decode([{ ...update(), action: "merge", target: "k4", sources: ["k1", "k2"] }]);
    expect(memoryMerge).toMatchObject({ targetKind: "memory", targetId: "mutable-memory",
      mergedCandidateIds: ["candidate-one", "candidate-two"] });
  });

  test("fills unused removal fields mechanically from the bound target", () => {
    expect(decode([{ action: "remove", target: "k4", reason: "No longer relevant", evidence: ["e1"] }])[0])
      .toEqual({ action: "remove", targetKind: "memory", targetId: "mutable-memory", targetVersion: "7",
        reason: "No longer relevant", observationIds: ["observation-one"], content: "", tags: [],
        score: 0, certainty: "inferred", reinforced: false, reconsiderAt: null, mergedCandidateIds: [] });
  });

  test("scheduled updates and removals never manufacture fresh evidence or reinforcement", () => {
    const refs = references(true);
    const [updated] = decode([{ action: "update", target: "k1", ...content, score: 35 }], refs);
    expect(updated).toMatchObject({ targetId: "candidate-one", targetVersion: "7", observationIds: [], reinforced: false });
    const [removed] = decode([{ action: "remove", target: "k1", reason: "No longer relevant" }], refs);
    expect(removed).toMatchObject({ action: "remove", observationIds: [], reinforced: false });
    expect(rejection(creation(), refs).message).toBe("learning_review_action_invalid");
    expect(rejection({ ...update(), action: "merge", sources: ["k2"] }, refs).message).toBe("learning_review_action_invalid");
  });

  test.each([
    [{ ...update(), target: "private-unknown-id" }, "learning_decision_target_unknown", "target_binding"],
    [{ ...update(), target: "candidate-one" }, "learning_decision_target_unknown", "target_binding"],
    [{ ...update(), target: "k3" }, "learning_memory_protected", "target_binding"],
    [{ ...update(), evidence: ["private-unknown-evidence"] }, "learning_decision_source_unknown", "evidence_binding"],
    [{ ...update(), action: "merge", sources: ["k4"] }, "learning_merge_source_unknown", "target_binding"],
    [{ ...update(), action: "merge", sources: ["private-unknown-source"] }, "learning_merge_source_unknown", "target_binding"],
  ])("rejects references outside the exact binding: %j", (raw, reason, stage) => {
    const error = rejection(raw);
    expect(error.message).toBe(reason);
    expect(error.diagnostics).toEqual({ stage, decisionIndex: 0, action: raw.action });
    expect(JSON.stringify(error)).not.toContain("private-unknown");
  });

  test("independently rejects protected merge sources and excluded or non-due targets", () => {
    const refs = references();
    const knowledge = new Map(refs.knowledge);
    knowledge.set("k2", { ...knowledge.get("k2")!, mutable: false });
    expect(rejection({ ...update(), action: "merge", sources: ["k2"] }, { ...refs, knowledge }).message)
      .toBe("learning_memory_protected");
    expect(rejection(update(), { ...refs, targetRefs: ["k4"] }).message).toBe("learning_decision_target_unknown");
    const scheduled = { ...references(true), targetRefs: ["k1", "k2"] };
    expect(rejection({ action: "update", target: "k2", ...content }, scheduled).message).toBe("learning_review_target_not_due");
  });

  test.each([
    { ...creation(), targetKind: "candidate", targetId: null, targetVersion: null },
    { ...creation(), reinforced: false },
    { ...creation(), content: 42 },
    { ...creation(), score: "45" },
    { ...creation(), privateExtraField: "private output text" },
    { ...update(), sources: ["k2"] },
  ])("rejects undeclared fields and wrong types without legacy fallback or coercion: %j", raw => {
    const error = rejection(raw);
    expect(error.message).toBe("learning_review_output_contract_invalid");
    expect(error.diagnostics).toEqual({ stage: "shape", decisionIndex: 0, action: raw.action });
    expect(JSON.stringify(error)).not.toContain("privateExtraField");
    expect(JSON.stringify(error)).not.toContain("private output text");
  });

  test("does not erase undeclared root fields while reading the decision envelope", () => {
    const refs = references();
    expect(() => decodeLearningReviewDecisions(JSON.stringify({ decisions: [], privateExtra: "secret" }), refs,
      createLearningReviewFormat(refs))).toThrow("learning_review_output_contract_invalid");
    expect(decode([])).toEqual([]);
  });

  test("keeps canonical content validation and bounded action diagnostics", () => {
    const contentError = rejection({ ...creation(), content: "   " });
    expect(contentError.message).toBe("learning_content_invalid");
    expect(contentError.diagnostics).toEqual({ stage: "domain_validation", decisionIndex: 0, action: "create" });
    const actionError = rejection({ ...creation(), action: "private-model-command" });
    expect(actionError.message).toBe("learning_action_invalid");
    expect(actionError.diagnostics.action).toBe("unknown");
    expect(JSON.stringify(actionError)).not.toContain("private-model-command");
  });

  test("preserves bounded envelope diagnostics without copying invalid output", () => {
    const refs = references();
    try { decodeLearningReviewDecisions("private invalid model output", refs, createLearningReviewFormat(refs)); }
    catch (error) {
      expect(error).toBeInstanceOf(LearningDecisionEnvelopeError);
      expect((error as Error).message).toBe("learning_output_invalid_json");
      expect(JSON.stringify(error)).not.toContain("private invalid");
      return;
    }
    throw new Error("Expected invalid envelope rejection");
  });
});
