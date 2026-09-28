import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LearningMemoryDecision } from "../long-term-memory/maturation/contracts.js";
import { LearningDecisionEnvelopeError } from "../long-term-memory/maturation/decision-envelope.js";
import { MAX_LEARNING_DECISIONS, parseLearningDecisions } from "../long-term-memory/maturation/decisions.js";
import { MAX_MEMORY_CONTENT_CHARACTERS } from "../long-term-memory/policies/normalization.js";
import * as logger from "../observability/debug-logger.js";
import { parseLearningReviewOutput } from "../passive-learning/review-output.js";

const decision: LearningMemoryDecision = {
  action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
  content: "Prefers concise project summaries.", tags: ["work"], score: 55,
  reason: "Observed a consistent preference in separate work sessions.", certainty: "observed",
  reinforced: true, observationIds: ["observation-1"], mergedCandidateIds: [], reconsiderAt: null,
};
const batchId = "batch-envelope-test";
const secretValue = "PRIVATE_SCREEN_CONTENT_947";
const secretKey = "PRIVATE_SCREEN_KEY_862";
const metadata = (shape: Record<string, unknown> = {}) => ({ decisionLimit: MAX_LEARNING_DECISIONS, ...shape });

beforeEach(() => { vi.spyOn(logger, "traceDebug").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const rejected = [
  { name: "invalid JSON", text: `{${secretKey}: ${secretValue}`, reason: "learning_output_invalid_json", shape: metadata({ invalidJsonShape: "object_missing_closer" }) },
  { name: "root array", text: JSON.stringify([secretValue]), reason: "learning_output_object_required", shape: metadata({ rootType: "array" }) },
  { name: "null root", text: "null", reason: "learning_output_object_required", shape: metadata({ rootType: "null" }) },
  { name: "string root", text: JSON.stringify(secretValue), reason: "learning_output_object_required", shape: metadata({ rootType: "string" }) },
  { name: "number root", text: "42", reason: "learning_output_object_required", shape: metadata({ rootType: "number" }) },
  { name: "boolean root", text: "false", reason: "learning_output_object_required", shape: metadata({ rootType: "boolean" }) },
  { name: "missing decisions", text: JSON.stringify({ [secretKey]: secretValue }), reason: "learning_output_decisions_missing", shape: metadata({ rootType: "object", decisionsType: "missing" }) },
  ...[
    { type: "null", value: null }, { type: "string", value: secretValue },
    { type: "object", value: { [secretKey]: secretValue } }, { type: "number", value: 42 }, { type: "boolean", value: false },
  ].map(({ type, value }) => ({ name: `${type} decisions`, text: JSON.stringify({ decisions: value }),
    reason: "learning_output_decisions_not_array", shape: metadata({ rootType: "object", decisionsType: type }) })),
  { name: "more than twelve decisions", text: JSON.stringify({ decisions: Array.from({ length: 13 }, () => ({ [secretKey]: secretValue })) }),
    reason: "learning_output_decision_limit", shape: metadata({ rootType: "object", decisionsType: "array", decisionCount: 13 }) },
  { name: "fenced JSON", text: '```json\n{"decisions":[]}\n```', reason: "learning_output_invalid_json", shape: metadata({ invalidJsonShape: "markdown_fence" }) },
  { name: "double-encoded JSON", text: JSON.stringify('{"decisions":[]}'), reason: "learning_output_object_required", shape: metadata({ rootType: "string" }) },
];

describe("strict learning decision envelope and bounded diagnostics", () => {
  test.each(rejected)("rejects $name without coercion or passive-content diagnostics", ({ text, reason, shape }) => {
    expect(() => parseLearningDecisions(text)).toThrow(reason);
    expect(logger.traceDebug).not.toHaveBeenCalled();
    let caught: unknown;
    try { parseLearningReviewOutput(text, batchId); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(LearningDecisionEnvelopeError);
    expect(caught).toMatchObject({ message: reason, shape });
    expect(logger.traceDebug).toHaveBeenCalledExactlyOnceWith("runtime.passive_learning", "review.output_rejected", {
      requestId: `learning:${batchId}`, batchId, reason, ...shape,
    });
    const emitted = JSON.stringify(vi.mocked(logger.traceDebug).mock.calls);
    expect(emitted).not.toContain(secretValue);
    expect(emitted).not.toContain(secretKey);
  });

  test("accepts an explicit empty decisions array without logging a failure", () => {
    const text = '{"decisions":[]}';
    expect(parseLearningDecisions(text)).toEqual([]);
    expect(parseLearningReviewOutput(text, batchId)).toEqual([]);
    expect(logger.traceDebug).not.toHaveBeenCalled();
  });

  test("parses a complete real decision without dropping fields or changing the contract", () => {
    const text = JSON.stringify({ decisions: [decision] });
    expect(parseLearningDecisions(text)).toEqual([decision]);
    expect(parseLearningReviewOutput(text, batchId)).toEqual([decision]);
    expect(logger.traceDebug).not.toHaveBeenCalled();
  });

  test("retains every valid decision at the limit and rejects an extra one rather than truncating", () => {
    const decisions = Array.from({ length: 12 }, (_, index) => ({ ...decision, content: `Works on project number ${index}.` }));
    expect(parseLearningReviewOutput(JSON.stringify({ decisions }), batchId)).toEqual(decisions);
    expect(logger.traceDebug).not.toHaveBeenCalled();
    expect(() => parseLearningReviewOutput(JSON.stringify({ decisions: [...decisions, decision] }), batchId))
      .toThrow("learning_output_decision_limit");
    expect(logger.traceDebug).toHaveBeenCalledOnce();
  });

  test.each([
    { change: { content: 42 }, reason: "learning_content_invalid" },
    { change: { score: "55" }, reason: "learning_score_invalid" },
    { change: { content: "x".repeat(MAX_MEMORY_CONTENT_CHARACTERS + 1) }, reason: "learning_content_exceeds_limit" },
  ])("does not coerce or truncate invalid decision content: $reason", ({ change, reason }) => {
    const text = JSON.stringify({ decisions: [{ ...decision, ...change }] });
    expect(() => parseLearningDecisions(text)).toThrow(reason);
    expect(() => parseLearningReviewOutput(text, batchId)).toThrow(reason);
    expect(logger.traceDebug).not.toHaveBeenCalled();
  });
});
