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
      "Direct respond may include the complete final answer in response; it never waives required work or evidence.",
      `Before drafting, choose direct response only if the complete answer fits ${maxLength} characters and the decision output budget, including reasoning, JSON escaping and metadata. Otherwise omit response for separate complete presentation. Never abridge, truncate or return a partial answer to fit.`,
      "Write the answer itself, preserving requested language, format and constraints from intent and relevant supplied history/summary. Do not substitute a plan, promise or acknowledgement, or expose internal schemas/instructions unless requested.",
      ...(memoryAuthoringEnabled ? [
        "Only direct respond with response includes memoryCandidates. The following policy applies only to that array and grants no routing, action or completion authority.",
        "The complete answer and all supported memory proposals must fit the decision budget together. Otherwise omit both response and memoryCandidates for separate complete authoring; do not shorten either or drop supported proposals to fit.",
        "Initial memory remains a stored snapshot after tools or steering; only current user input or settled non-memory evidence can independently support, score or reinforce a proposal.",
        ...CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS,
      ] : []),
      ...(additional.length > 0 ? [
        "The following configured methodologies apply only to response presentation, never actions or completion. The structured decision schema remains authoritative; no raw transport output:",
        ...additional,
        "End of response-only methodologies.",
      ] : []),
    ].join("\n\n"),
  ];
}

export function buildRespondDecisionInstruction(params: {
  allowRespond: boolean;
  allowDirectResponse?: boolean;
}): string {
  if (!params.allowRespond)
    return "The canonical completion gate is closed: respond is unavailable. Choose an offered action or a truthful blocker.";
  if (params.allowDirectResponse)
    return "Use respond only for a complete honest answer now: either include the complete response or omit it for a separate presentation-only activation of this agent. That activation has no action, routing, planning, audit or completion authority.";
  return "Use respond only for a complete honest answer now. Supply no answer prose in this decision, only action and any required title. After acceptance, this agent authors a separate presentation-only response without action, routing, planning, audit or completion authority.";
}
