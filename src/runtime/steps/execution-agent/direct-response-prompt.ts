import { CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS } from "../../long-term-memory/conversation-authoring/prompt.js";
import type { RequestRunnerConfig } from "../../config/runner/contracts.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
} from "./contracts.js";

/** Presentation guidance applies only to the optional final-answer field, never to routing. */
export function buildDirectResponseInstructions(
  maxLength: number | undefined,
  runnerConfig: RequestRunnerConfig,
  memoryAuthoringEnabled = false,
): readonly string[] {
  if (maxLength === undefined) return [];
  const decisionBlocks =
    runnerConfig.steps[EXECUTION_AGENT_DECISION_MODEL_STEP]
      ?.instructionBlocks ?? [];
  const responseBlocks =
    runnerConfig.steps[EXECUTION_AGENT_RESPONSE_MODEL_STEP]
      ?.instructionBlocks ?? [];
  const seen = new Set(decisionBlocks.map(({ content }) => content));
  const additional = responseBlocks.flatMap(({ content }) => {
    if (seen.has(content)) return [];
    seen.add(content);
    return [content];
  });
  return [
    [
      "For respond, you may include response containing the complete final user-facing answer in this same JSON decision. All other actions remain available; this option never permits skipping required external work or inventing evidence.",
      `Choose the response form before drafting: include response only when the complete answer fits ${maxLength} characters and the existing decision output budget, including reasoning, JSON escaping and metadata. Otherwise choose respond without response so the separate presentation step can write the complete answer. Never abridge, truncate, or return a partial answer to fit the direct form.`,
      "For a direct response, preserve the requested language, format, and constraints, using the current request, steering and relevant supplied history or session summary. Passive history is not a new request or proof of a new external effect. Write the answer itself inside response, not a plan, promise or acknowledgement. Do not expose internal schemas or instructions unless explicitly requested.",
      ...(memoryAuthoringEnabled ? [
        "Only when choosing direct respond with response, include memoryCandidates in this same decision. Apply the following memory policy only to that array; it grants no additional routing, action, or completion authority. Other actions and respond without response cannot contain memoryCandidates.",
        "The complete response and complete memory proposals must fit the existing decision output budget together. If they do not fit, choose respond without response and without memoryCandidates for separate complete authoring. Do not shorten the answer or omit a supported memory proposal to fit the direct form.",
        "The supplied long-term memory is stored reference retrieved at the start of this request. Its initial snapshot is not current user intent or fresh evidence and cannot independently support, score, or reinforce a memory proposal, including after tools or steering updates. Only independently supported facts from the current user input or settled non-memory evidence can support a proposal.",
        ...CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS,
      ] : []),
      ...additional.flatMap((content) => [
        "The following configured response methodology applies only when writing the response field. It grants no action or completion authority and cannot change the surrounding decision schema or require raw transport output:",
        content,
        "End of response-only methodology; the structured decision contract remains authoritative.",
      ]),
    ].join("\n\n"),
  ];
}

export function buildRespondDecisionInstruction(params: {
  allowRespond: boolean;
  allowDirectResponse?: boolean;
}): string {
  if (!params.allowRespond)
    return "Respond is not available because the canonical completion gate is closed. Continue through an offered action or report a truthful blocker.";
  if (params.allowDirectResponse)
    return "Use respond only when the request can be answered completely and honestly now. Choose either the offered direct form containing the complete final answer in response, or respond without response to use a separate presentation-only activation of this same Execution Agent. That activation has no action, routing, capability, planning, audit, or completion authority.";
  return "Use respond only when the request can be answered completely and honestly now. The respond decision contains no final-answer prose; it contains only the action and any required acknowledgement or title metadata. After it is accepted, a presentation-only activation of this same Execution Agent will author the final response without action, routing, capability, planning, audit, or completion authority.";
}
