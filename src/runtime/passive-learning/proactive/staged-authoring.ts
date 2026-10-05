import type { LearningKnowledgeEntry } from "../../long-term-memory/maturation/contracts.js";
import type { StagedReviewCall } from "../staged-review-call.js";
import type { ProactiveConversationStyleReference } from "./conversation-style-reference.js";
import { buildStagedProactiveAuthoringMessages, buildStagedProactiveTitleMessages,
  buildStagedProactiveHandoffMessages } from "./staged-context.js";
import { PROACTIVE_MESSAGE_STAGE } from "./staged-contract.js";
import { STAGED_PROACTIVE_AUTHORING_FORMAT } from "./staged-format.js";
import { decodeStagedProactiveMessage, decodeStagedProactiveTitle,
  decodeStagedProactiveHandoffBrief } from "./staged-output.js";

/** Each author writes one text body; the runtime assembles the accepted proposal. */
export async function authorStagedProactiveProposal(input: Readonly<{
  reviewId: string;
  objective: string;
  sources: readonly LearningKnowledgeEntry[];
  styleReference?: ProactiveConversationStyleReference;
}>, call: StagedReviewCall): Promise<Readonly<{ title: string; message: string; handoffBrief: string }>> {
  const message = await call(PROACTIVE_MESSAGE_STAGE, {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "proactive_review_timeout",
    format: STAGED_PROACTIVE_AUTHORING_FORMAT,
    messages: buildStagedProactiveAuthoringMessages(input),
    accept: decodeStagedProactiveMessage,
  });
  const title = await call("title", {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "proactive_review_timeout",
    format: STAGED_PROACTIVE_AUTHORING_FORMAT,
    messages: buildStagedProactiveTitleMessages({ reviewId: input.reviewId, objective: input.objective, message }),
    accept: decodeStagedProactiveTitle,
  });
  const handoffBrief = await call("handoff", {
    modelStep: "learning.batch", contextRetention: "exact", timeoutReason: "proactive_review_timeout",
    format: STAGED_PROACTIVE_AUTHORING_FORMAT,
    messages: buildStagedProactiveHandoffMessages({ reviewId: input.reviewId, objective: input.objective,
      message, sources: input.sources }),
    accept: decodeStagedProactiveHandoffBrief,
  });
  return Object.freeze({ title, message, handoffBrief });
}
