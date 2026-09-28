import { writeFile } from "node:fs/promises";
import { vi } from "vitest";
import type { ModelGatewayClient, RuntimeConfig } from "../../ports.js";
import type { LearningKnowledgeContext, LearningKnowledgeEntry } from "../../long-term-memory/maturation/contracts.js";
import { createRuntimePassiveLearningModel } from "../../passive-learning/model.js";
import type { LearningReviewInput } from "../../passive-learning/review-references.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";

export const LEARNING_NOW = Date.parse("2026-09-27T08:00:00.000Z");
export const learningCandidate: LearningKnowledgeEntry = { kind: "candidate", id: "private-candidate", version: "3",
  content: "Possibly interested in hiking.", tags: ["outdoors"], score: 40, reason: "Tentative interest",
  certainty: "inferred", mutable: true, lastReinforcedAt: null, reconsiderAt: null };
export function learningInput(entries: readonly LearningKnowledgeEntry[] = []): LearningReviewInput {
  const context: LearningKnowledgeContext = { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
    presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1,
    knowledgeRevision: 1, referenceTime: new Date(LEARNING_NOW).toISOString(), entries, omitted: 0 };
  return { batchId: "batch-a", modelProfileId: "learning", context, promotionScore: 90,
    signal: new AbortController().signal, observations: [{ id: "private-observation", deviceId: "device", sequence: 1,
      timestamp: new Date(LEARNING_NOW).toISOString(), source: { app: "browser", windowId: "window", title: "Hiking route search" },
      content: "Comparing hiking routes for another trip.", kind: "view", extraction: "uia", coverage: "partial" }] };
}
export const learningIdea = { ref: "d1", objective: "A tentative hiking interest.", evidence: ["o1"] };
export const learningDraft = { ref: "d1", content: "Possibly interested in hiking.", tags: ["outdoors"], reason: "Purposeful research." };
export const learningAssessment = { ref: "d1", score: 45, certainty: "inferred" };
export const learningTiming = { ref: "d1", reconsiderAfterMinutes: null };
export const learningOutput = (decisions: unknown[]) => ({ text: JSON.stringify({ decisions }), meta: { providerCompletionReason: "stop" } });
export async function learningFixture(direct = false, timeoutMs = 5000) {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "learning", steps: {} } },
    context: { outputReserveTokens: 600, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
    stepDefaults: { timeoutMs }, steps: {} }));
  const config: RuntimeConfig = { ...base, models: { defaults: { profileId: "learning" },
    providers: { local: { type: "ollama" } }, profiles: {
      learning: { provider: "local", model: "scripted", contextWindowTokens: 16000 } } },
    ...(direct ? { modelExecutionPolicies: { learning: { policy: "execution-agent-v1" } } } : {}) };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>();
  const gateway: ModelGatewayClient = { invoke, invokeRaw: vi.fn() };
  return { config, invoke, gateway, model: createRuntimePassiveLearningModel({ config, models: gateway }) };
}
export function enqueueLearningCreation(invoke: Awaited<ReturnType<typeof learningFixture>>["invoke"], score = 45) {
  for (const row of [learningIdea, learningDraft, { ...learningAssessment, score }, learningTiming])
    invoke.mockResolvedValueOnce(learningOutput([row]));
}
export function enqueueLearningUpdate(invoke: Awaited<ReturnType<typeof learningFixture>>["invoke"], score = 95) {
  for (const row of [learningIdea, { ref: "d1", match: "k1" }, { ref: "d1", change: "revise" }, learningDraft,
    { ...learningAssessment, score, reinforced: true }, learningTiming])
    invoke.mockResolvedValueOnce(learningOutput([row]));
}
