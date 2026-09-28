import { describe, expect, test } from "vitest";
import { projectOllamaFormat } from "../../model-gateway/structured-output/ollama-format.js";
import { projectOpenAIResponsesFormat } from "../../model-gateway/structured-output/openai-format.js";
import { createLearningReviewFormat } from "../passive-learning/review-response-format.js";
import { createLearningReviewPresentation, type LearningReviewInput } from "../passive-learning/review-references.js";
import { PROACTIVE_DECISION_FORMAT } from "../passive-learning/proactive/model.js";
import { parseLearningDecisions } from "../long-term-memory/maturation/decisions.js";
import { validateProactiveDecision } from "../passive-learning/proactive/contracts.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";

function reviewReferences(scheduled = false) {
  const input: LearningReviewInput = {
    batchId: "batch", modelProfileId: "model", signal: new AbortController().signal, promotionScore: 80,
    context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
      referenceTime: "2026-09-25T14:00:00.000Z", omitted: 0,
      entries: ["candidate-one", "candidate-two"].map(id => ({ kind: "candidate", id, version: "1",
        content: "Prefers focused reviews", tags: [], score: 45, reason: "Repeated evidence", certainty: "inferred",
        mutable: true, lastReinforcedAt: null, reconsiderAt: null })) },
    observations: scheduled ? [] : [{ id: "observed", deviceId: "computer", sequence: 1,
      timestamp: "2026-09-25T14:00:00.000Z", source: { app: "editor", windowId: "project" },
      content: "Independent review activity", kind: "view", extraction: "uia", coverage: "partial" }],
    ...(scheduled ? { cause: { kind: "scheduled_knowledge_review", dueEntries: [
      { kind: "candidate", id: "candidate-one", version: "1" },
    ] } } : {}),
  };
  return createLearningReviewPresentation(input).references;
}
const activityFormat = createLearningReviewFormat(reviewReferences());
const scheduledFormat = createLearningReviewFormat(reviewReferences(true));

describe("Co-worker provider schema compatibility", () => {
  test.each([
    ["activity review", activityFormat, 9],
    ["scheduled reassessment", scheduledFormat, 3],
    ["proactive review", PROACTIVE_DECISION_FORMAT, 3],
  ] as const)("%s reaches Ollama projection and retains cloud constraints", (_name, format, count) => {
    const original = structuredClone(format);
    const projected = projectOllamaFormat(format);
    expect(projected.diagnostics).toHaveLength(count);
    expect(projected.diagnostics.every(({ keyword }) => keyword === "maxLength")).toBe(true);
    expect(JSON.stringify(projected.format)).not.toContain('"maxLength"');
    expect(projectOpenAIResponsesFormat(format).format?.schema).toEqual(format.schema);
    expect(format).toEqual(original);
  });

  test("unrelated formats still reject an undeclared unsupported constraint", () => {
    expect(() => projectOllamaFormat({ type: "json_schema", name: "unrelated",
      schema: { type: "string", maxLength: 20 } })).toThrow("ollama_schema_constraint_not_post_validated:/maxLength");
  });
});

const learningDecision = {
  action: "create", targetKind: "candidate", targetId: null, targetVersion: null,
  content: "Prefers small focused reviews.", tags: [], mergedCandidateIds: [],
  observationIds: ["observed"], score: 45, reason: "Repeated independent evidence.",
  certainty: "inferred", reinforced: true, reconsiderAt: null,
};

test.each(["ollama", "openai"])("%s constrains each activity action and exact current-review references", (provider) => {
  const schema = (provider === "ollama"
    ? projectOllamaFormat(activityFormat).format
    : projectOpenAIResponsesFormat(activityFormat).format?.schema) as Record<string, unknown>;
  const content = { content: learningDecision.content, tags: [], score: 45, reason: learningDecision.reason,
    certainty: "inferred", reconsiderAt: null };
  const create = { action: "create", ...content, evidence: ["o1"] };
  const update = { action: "update", target: "k1", ...content, evidence: ["o1"], reinforced: true };
  const merge = { ...update, action: "merge", sources: ["k2"] };
  const remove = { action: "remove", target: "k1", reason: "No longer relevant", evidence: ["o1"] };
  const validate = (decision: unknown) => validateJsonSchemaValue(schema, { decisions: [decision] });
  for (const decision of [create, update, merge, remove]) expect(validate(decision)).toBeUndefined();
  for (const invalid of [{ targetKind: "memory" }, { targetId: "invented" }, { targetVersion: "1" },
    { target: "k1" }, { reinforced: false }, { sources: ["k2"] }, { evidence: ["observed"] }]) {
    expect(validate({ ...create, ...invalid })).toBeDefined();
  }
  expect(validate({ ...update, target: "candidate-one" })).toBeDefined();
  expect(validate({ ...update, target: "k99" })).toBeDefined();
  expect(validate({ ...merge, sources: ["candidate-two"] })).toBeDefined();
  expect(validate({ ...merge, sources: [] })).toBeDefined();
  for (const target of ["k1", "k2"]) {
    expect(validate({ ...merge, target, sources: [target] })).toBeDefined();
    expect(validate({ ...merge, target, sources: ["k1", "k2"] })).toBeDefined();
    expect(validate({ ...merge, target, sources: [target === "k1" ? "k2" : "k1"] })).toBeUndefined();
  }
  expect(validate({ ...remove, content: "Unrequested field" })).toBeDefined();
  expect(validateJsonSchemaValue(schema, { decisions: [] })).toBeUndefined();
  expect(projectOpenAIResponsesFormat(activityFormat).diagnostics).toEqual([]);
});

test("a lone candidate cannot merge into itself", () => {
  const format = createLearningReviewFormat({ ...reviewReferences(), targetRefs: ["k1"], mergeRefs: ["k1"] });
  expect(validateJsonSchemaValue(format.schema, { decisions: [{ action: "merge", target: "k1", sources: ["k1"],
    content: "A pattern", tags: [], score: 45, reason: "Evidence", certainty: "observed", reconsiderAt: null,
    evidence: ["o1"], reinforced: true }] })).toBeDefined();
});

test.each(["ollama", "openai"])("%s allows scheduled update/remove only, without evidence or reinforcement", provider => {
  const schema = (provider === "ollama" ? projectOllamaFormat(scheduledFormat).format
    : projectOpenAIResponsesFormat(scheduledFormat).format?.schema) as Record<string, unknown>;
  const update = { action: "update", target: "k1", content: "The plan is no longer upcoming", tags: [],
    score: 35, reason: "Its date passed", certainty: "inferred", reconsiderAt: null };
  const remove = { action: "remove", target: "k1", reason: "No longer relevant" };
  const validate = (decision: unknown) => validateJsonSchemaValue(schema, { decisions: [decision] });
  expect(validate(update)).toBeUndefined(); expect(validate(remove)).toBeUndefined();
  for (const invalid of [{ action: "create" }, { action: "merge", sources: ["k2"] },
    { target: "k2" }, { evidence: [] }, { reinforced: false }]) expect(validate({ ...update, ...invalid })).toBeDefined();
});

test.each([
  ["content", "x".repeat(4001), "learning_content_exceeds_limit"],
  ["content", "x" + " ".repeat(4000), "learning_content_exceeds_limit"],
  ["reason", "x".repeat(1001), "learning_reason_invalid"],
])("learning parser enforces the projected %s length", (field, value, error) => {
  expect(() => parseLearningDecisions(JSON.stringify({ decisions: [{ ...learningDecision, [field]: value }] }))).toThrow(error);
});

const now = Date.parse("2026-09-25T14:00:00Z");
const sources = [{ kind: "candidate" as const, id: "candidate", version: "1" }];
const proactiveDecision = {
  kind: "proposal", title: "A useful idea", message: "Would a focused review help?",
  reason: "Repeated activity", sources, expiresAt: new Date(now + 3600000).toISOString(), reconsiderAt: null,
};
test.each(["ollama", "openai"])("%s accepts an omitted explanation as null or empty text", provider => {
  const schema = (provider === "ollama" ? projectOllamaFormat(PROACTIVE_DECISION_FORMAT).format
    : projectOpenAIResponsesFormat(PROACTIVE_DECISION_FORMAT).format?.schema) as Record<string, unknown>;
  for (const reason of [null, "", "An explanation"]) {
    expect(validateJsonSchemaValue(schema, { ...proactiveDecision, reason })).toBeUndefined();
    expect(validateJsonSchemaValue(schema, { kind: "none", title: null, message: null, reason,
      sources: [], expiresAt: null, reconsiderAt: null })).toBeUndefined();
  }
});
test.each([
  ["title", 161, "proactive_title_invalid"],
  ["message", 4001, "proactive_message_invalid"],
  ["reason", 1001, "proactive_reason_invalid"],
])("proactive parser enforces the projected %s length", (field, length, error) => {
  expect(() => validateProactiveDecision({ ...proactiveDecision, [field]: "x".repeat(length) }, sources, now)).toThrow(error);
});
