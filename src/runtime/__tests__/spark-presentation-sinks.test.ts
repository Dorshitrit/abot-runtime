import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { SPARK_COMPANION_VOICE_INSTRUCTIONS } from "../context/spark-conversation-policy.js";
import { buildProactiveReviewMessages } from "../passive-learning/proactive/model.js";
import type { ProactiveReviewInput } from "../passive-learning/proactive/contracts.js";
import { PROACTIVE_REVIEW_INSTRUCTIONS } from "../passive-learning/proactive/prompt.js";
import { buildStagedProactiveAuthoringMessages, buildStagedProactiveObjectiveMessages,
  buildStagedProactiveTimingMessages, createStagedProactivePresentation } from "../passive-learning/proactive/staged-context.js";
import { STAGED_PROACTIVE_AUTHORING_INSTRUCTIONS, STAGED_PROACTIVE_OBJECTIVE_INSTRUCTIONS,
  STAGED_PROACTIVE_SELECTION_INSTRUCTIONS, STAGED_PROACTIVE_TIMING_INSTRUCTIONS } from "../passive-learning/proactive/staged-prompt.js";
import type { ModelGatewayClient } from "../ports.js";
import { buildDegradedFinalizationModelInput } from "../steps/degraded-finalization/input.js";
import { DEGRADED_FINALIZATION_INSTRUCTIONS } from "../steps/degraded-finalization/prompt.js";
import { runModelAuthoredDegradedFinalization } from "../steps/degraded-finalization/model-authored.js";
import { runSuperDegradedFinalization } from "../steps/degraded-finalization/super.js";
import { createRootInvalidOutputRequest } from "./support/root-invalid-output-fixture.js";

const voice = SPARK_COMPANION_VOICE_INSTRUCTIONS.join("\n");
const failure = { problem: { stage: "decision", code: "invalid_supervisor_decision" }, progress: null };

function reviewInput(): ProactiveReviewInput {
  return { reviewId: "spark-voice-review", modelProfileId: "default", signal: new AbortController().signal,
    recentProposals: [], context: { kind: "learning_knowledge_reference_v1", authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", repositoryRevision: 1, knowledgeRevision: 1,
      referenceTime: "2026-10-01T12:00:00Z", omitted: 0,
      entries: [{ kind: "candidate", id: "candidate", version: "1", content: "A possible project interest",
        tags: [], score: 40, reason: "Tentative", certainty: "inferred", mutable: true,
        lastReinforcedAt: null, reconsiderAt: null }] } };
}

describe("SPARK presentation sinks", () => {
  test("direct review retains passive source topology and constrains voice to its instruction block", () => {
    const input = reviewInput();
    const messages = buildProactiveReviewMessages(input);
    expect(messages.map(({ role }) => role)).toEqual(["system", "system", "system", "system"]);
    expect(messages[0]!.content).toContain(PROACTIVE_REVIEW_INSTRUCTIONS);
    expect(messages[0]!.content.split(voice)).toHaveLength(2);
    expect(JSON.parse(messages[1]!.content)).toMatchObject({
      purpose: "propose_a_message_only_without_action_authority", reviewId: input.reviewId,
    });
    expect(JSON.parse(messages[2]!.content)).toEqual(input.context);
    expect(JSON.parse(messages[3]!.content)).toMatchObject({ authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", proposals: [], omitted: 0 });
    for (const message of messages.slice(1)) expect(message.content).not.toContain(voice);
  });

  test("staged review applies voice only to authoring without changing selection, objective or timing", () => {
    const input = reviewInput();
    const selection = createStagedProactivePresentation(input, buildProactiveReviewMessages(input));
    const bound = { reviewId: input.reviewId, sources: input.context.entries };
    const objective = buildStagedProactiveObjectiveMessages({ ...bound, priorProposals: selection.priorProposals });
    const timing = buildStagedProactiveTimingMessages({ ...bound, referenceTime: input.context.referenceTime, message: null });
    expect(selection.messages[0]!.content).toBe(STAGED_PROACTIVE_SELECTION_INSTRUCTIONS);
    expect(objective[0]!.content).toBe(STAGED_PROACTIVE_OBJECTIVE_INSTRUCTIONS);
    expect(timing[0]!.content).toBe(STAGED_PROACTIVE_TIMING_INSTRUCTIONS);
    for (const message of [...selection.messages, ...objective, ...timing]) expect(message.content).not.toContain(voice);
    const authored = buildStagedProactiveAuthoringMessages({ ...bound, objective: "Offer to discuss the possible project" });
    expect(authored.map(({ role }) => role)).toEqual(["system", "system", "system"]);
    expect(authored[0]!.content).toContain(STAGED_PROACTIVE_AUTHORING_INSTRUCTIONS);
    expect(authored[0]!.content.split(voice)).toHaveLength(2);
    expect(JSON.parse(authored[1]!.content)).toMatchObject({ actionAuthority: "none",
      purpose: "author_only_the_selected_message", objective: "Offer to discuss the possible project" });
    expect(JSON.parse(authored[2]!.content)).toMatchObject({ authority: "passive_reference",
      presenceEffect: "does_not_authorize_actions_or_add_user_intent", entries: input.context.entries });
  });

  test("degraded framing adds voice only for the canonical kind and preserves the exact failure schema and evidence", () => {
    const request = createRootInvalidOutputRequest(vi.fn());
    const ordinary = buildDegradedFinalizationModelInput({ request, input: failure });
    const companion = buildDegradedFinalizationModelInput({ request: { ...request, sessionKind: "spark" }, input: failure });
    expect(ordinary.messages[0]!.content).toBe(DEGRADED_FINALIZATION_INSTRUCTIONS);
    expect(companion.messages[0]!.content).toContain(voice);
    expect(companion.messages[0]!.content).toContain(DEGRADED_FINALIZATION_INSTRUCTIONS);
    expect(companion.messages.map(({ role }) => role)).toEqual(["system", "user"]);
    expect(companion.messages.slice(1)).toEqual(ordinary.messages.slice(1));
    expect(companion.format).toEqual(ordinary.format);
  });

  test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
    "%s carries scoped identity into its actual degraded presentation call without changing output", async (policy) => {
      const phrasing = { failureNotice: "I could not finish this safely.", nextStep: "Review the established state." };
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: JSON.stringify(phrasing), meta: {} }));
      const request = createRootInvalidOutputRequest(invoke, policy, { sessionKind: "spark" });
      const params = { request, input: failure, maxResponseChars: 500 };
      const actual = policy === "execution-agent-v1"
        ? await runModelAuthoredDegradedFinalization(params)
        : (await runSuperDegradedFinalization({ ...params, steeringVersion: 0 })).output;
      expect(actual).toBe(`${phrasing.failureNotice}\n\n${phrasing.nextStep}`);
      expect(invoke).toHaveBeenCalledOnce();
      const call = invoke.mock.calls[0]![0];
      expect(call.modelStep).toBe("degraded.finalization");
      expect((call.messages as readonly ChatMessage[])[0]!.content).toContain(voice);
      expect(call.format).toEqual(buildDegradedFinalizationModelInput(params).format);
      expect(request.onAnswerToken).not.toHaveBeenCalled();
    },
  );
});
