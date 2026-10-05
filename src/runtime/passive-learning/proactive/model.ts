import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RuntimeConfig, ModelGatewayClient, SessionStore } from "../../ports.js";
import { loadRequestRunnerConfig } from "../../config/runner/loader.js";
import { RequestModelStepInvoker } from "../../model/invoke-step.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import { isBoundedProactiveText, type ProactiveReviewInput, type ProactiveDecision } from "./contracts.js";
import { decodeProactiveModelDecision } from "./model-output.js";
import { PROACTIVE_REVIEW_INSTRUCTIONS } from "./prompt.js";
import { resolveCoWorkerReviewMethod } from "../review-method.js";
import { runStagedCoWorkerReview } from "../staged-review-call.js";
import { runStagedProactiveReview } from "./staged-review.js";
import { MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS, PROACTIVE_PROPOSAL_STAGES } from "./staged-contract.js";
import { SPARK_COMPANION_VOICE_INSTRUCTIONS } from "../../context/spark-conversation-policy.js";
import { MAX_SPARK_HANDOFF_BRIEF_CHARACTERS } from "../../../sessions/spark-handoff-brief.js";

import { proactiveConversationStyleMessages, readProactiveConversationStyle } from "./conversation-style-reference.js";
import { PROACTIVE_CONVERSATION_STYLE_INSTRUCTIONS } from "./conversation-style-prompt.js";

const MODEL_STEP = "learning.batch" as const;
const MAX_CONTEXT_CHARACTERS = 24_000;
const MAX_RECENT_CHARACTERS = 12_000;
const properties = {
  kind: { type: "string", enum: ["none", "proposal"] },
  title: { type: ["string", "null"], maxLength: 160 },
  message: { type: ["string", "null"], maxLength: 4000 },
  handoffBrief: { type: ["string", "null"], maxLength: MAX_SPARK_HANDOFF_BRIEF_CHARACTERS },
  reason: { type: ["string", "null"], maxLength: 1000 },
  sources: { type: "array", maxItems: 12, items: {
    type: "object", additionalProperties: false, required: ["kind", "id", "version"],
    properties: { kind: { type: "string", enum: ["candidate", "memory"] },
      id: { type: "string" }, version: { type: "string" } },
  } },
  expiresAt: { type: ["string", "null"] },
  reconsiderAt: { type: ["string", "null"] },
};
export const PROACTIVE_DECISION_FORMAT = {
  type: "json_schema", name: "co_worker_proactive_decision", strict: true,
  // Model output bounds optional explanations; canonical validation bounds the rest.
  postValidatedSchemaConstraints: [
    { keyword: "maxLength", path: "/properties/title/maxLength" },
    { keyword: "maxLength", path: "/properties/message/maxLength" },
    { keyword: "maxLength", path: "/properties/handoffBrief/maxLength" },
    { keyword: "maxLength", path: "/properties/reason/maxLength" },
  ],
  schema: { type: "object", additionalProperties: false,
    required: Object.keys(properties), properties },
} satisfies ModelGatewayJsonSchemaFormat;

export function buildProactiveReviewMessages(input: ProactiveReviewInput): ChatMessage[] {
  const { context } = input;
  if (!isBoundedProactiveText(input.reviewId, 160)) throw new Error("proactive_review_id_invalid");
  if (!Number.isFinite(Date.parse(context.referenceTime))) throw new Error("proactive_reference_time_invalid");
  if (context.entries.length > 12 || JSON.stringify(context.entries).length > MAX_CONTEXT_CHARACTERS)
    throw new Error("proactive_knowledge_context_too_large");
  const recent: Record<string, unknown>[] = [];
  let recentSize = 0;
  for (const proposal of [...input.recentProposals].reverse()) {
    if (proposal.status !== "delivered" && proposal.status !== "dismissed") continue;
    const reference = { id: proposal.id, title: proposal.title, reason: proposal.reason,
      sources: proposal.sources, status: proposal.status, createdAt: proposal.createdAt };
    const size = JSON.stringify(reference).length;
    if (recent.length >= 20) break;
    if (recentSize + size > MAX_RECENT_CHARACTERS) continue;
    recent.push(reference);
    recentSize += size;
  }
  return [
    { role: "system", content: [PROACTIVE_REVIEW_INSTRUCTIONS,
      "The following identity and voice apply only to the user-facing title and message of an eligible proposal. They do not change whether to propose, source selection, timing, or action authority. Do not invent familiarity, memories, observations or completed work.",
      ...SPARK_COMPANION_VOICE_INSTRUCTIONS,
      ...(input.styleReference ? [PROACTIVE_CONVERSATION_STYLE_INSTRUCTIONS] : [])].join("\n") },
    { role: "system", content: JSON.stringify({ kind: "co_worker_proactive_assignment_v1",
      purpose: "propose_a_message_only_without_action_authority", reviewId: input.reviewId,
      referenceTime: context.referenceTime, applicability: "only_supplied_knowledge_and_bound_source_versions" }) },
    { role: "system", content: JSON.stringify(context) },
    { role: "system", content: JSON.stringify({ kind: "co_worker_prior_proposals_v1",
      authority: "passive_reference", presenceEffect: "does_not_authorize_actions_or_add_user_intent",
      proposals: recent, omitted: input.recentProposals.length - recent.length }) },
    ...proactiveConversationStyleMessages(input.styleReference),
  ];
}

export type RuntimeProactiveModel = Readonly<{
  validateProfile(profileId: string): void;
  review(input: ProactiveReviewInput): Promise<ProactiveDecision>;
  reviewMethod?(profileId: string): "direct" | "staged";
  canCompleteSavedReview?(input: ProactiveReviewInput): Promise<boolean>;
}>;

export function createRuntimeProactiveModel(options: {
  config: RuntimeConfig;
  models: ModelGatewayClient;
  now?: () => number;
  sessions?: Pick<SessionStore, "getSessionById">;
}): RuntimeProactiveModel {
  function profile(profileId: string) {
    if (!options.config.models?.profiles?.[profileId]) throw new Error("proactive_model_profile_unavailable");
    const runnerConfig = loadRequestRunnerConfig(options.config.requestRunner);
    const modelPreference = { profileId, scope: "all" as const };
    const selection = resolveModelContextAdmission({ runnerConfig, agentMode: "reasoning", modelStep: MODEL_STEP,
      modelPreference, modelPolicy: options.config.models, requestFormat: PROACTIVE_DECISION_FORMAT });
    if (selection.invocation.profile.id !== profileId) throw new Error("proactive_model_profile_overridden");
    return { runnerConfig, modelPreference };
  }
  async function review(input: ProactiveReviewInput, replayOnly = false): Promise<ProactiveDecision> {
    const { runnerConfig, modelPreference } = profile(input.modelProfileId);
    const snapshot: ProactiveReviewInput = { ...input, context: structuredClone(input.context),
      recentProposals: structuredClone(input.recentProposals),
      styleReference: await readProactiveConversationStyle(options.sessions) };
    input.signal.throwIfAborted();
    if (resolveCoWorkerReviewMethod(options.config, input.modelProfileId) === "staged") {
      const { referenceTime, ...knowledge } = snapshot.context;
      return runStagedCoWorkerReview({ activity: "proactive", reviewId: snapshot.reviewId,
        progress: snapshot.progress, binding: { knowledge, recentProposals: snapshot.recentProposals },
        referenceTime, expiresAt: new Date(Date.parse(referenceTime) + MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS).toISOString(),
        maxCalls: PROACTIVE_PROPOSAL_STAGES.length, now: options.now,
        maxProgressAgeMs: MAX_PROACTIVE_REVIEW_PROGRESS_AGE_MS, replayOnly,
        request: { requestId: `proactive:${snapshot.reviewId}`, runnerConfig, agentMode: "reasoning",
          modelPreference, modelPolicy: options.config.models!, modelGatewayClient: options.models,
          abortSignal: snapshot.signal, onThinkingDelta: () => {}, onThinkingTrace: () => {} },
        run: (call, savedReferenceTime) => {
          const bound = { ...snapshot, context: { ...snapshot.context, referenceTime: savedReferenceTime } };
          return runStagedProactiveReview(bound, call, buildProactiveReviewMessages(bound), options.now, !replayOnly);
        } });
    }
    const messages = buildProactiveReviewMessages(snapshot);
    const invoker = new RequestModelStepInvoker({ requestId: `proactive:${input.reviewId}`,
      runnerConfig, agentMode: "reasoning", modelPreference, modelPolicy: options.config.models!,
      modelGatewayClient: options.models, abortSignal: input.signal,
      onThinkingDelta: () => {}, onThinkingTrace: () => {} });
    return invoker.invoke({ modelStep: MODEL_STEP, format: PROACTIVE_DECISION_FORMAT,
      contextRetention: "exact", messages, timeoutReason: "proactive_review_timeout",
      accept(text, diagnostics) {
        const incomplete = resolveOutputIncompleteError(diagnostics, MODEL_STEP);
        if (incomplete) throw incomplete;
        return decodeProactiveModelDecision(text, snapshot);
      } });
  }
  return Object.freeze({
    validateProfile(profileId: string) { profile(profileId); },
    reviewMethod: (profileId: string) => resolveCoWorkerReviewMethod(options.config, profileId),
    review,
    async canCompleteSavedReview(input: ProactiveReviewInput): Promise<boolean> {
      if (resolveCoWorkerReviewMethod(options.config, input.modelProfileId) !== "staged") return false;
      try { await review(input, true); return true; }
      catch { input.signal.throwIfAborted(); return false; }
    },
  });
}
