import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { SPARK_COMPANION_VOICE_INSTRUCTIONS } from "../../context/spark-conversation-policy.js";
import {
  createDegradedFinalizationFormat,
  type DegradedFinalizationInput,
} from "./contract.js";
import {
  buildDegradedFinalizationUserPrompt,
  DEGRADED_FINALIZATION_INSTRUCTIONS,
} from "./prompt.js";

export function buildDegradedFinalizationModelInput(params: {
  request: RequestExecutionSeed;
  input: DegradedFinalizationInput;
  languageSampleText?: string;
}): {
  messages: ChatMessage[];
  format: ReturnType<typeof createDegradedFinalizationFormat>;
} {
  return {
    messages: [
      {
        role: "system",
        content: buildDegradedPresentationInstructions(params.request.sessionKind),
      },
      {
        role: "user",
        content: buildDegradedFinalizationUserPrompt({
          requestText: params.languageSampleText ?? params.request.prompt,
          problemText: JSON.stringify(params.input.problem, null, 2),
        }),
      },
    ],
    format: createDegradedFinalizationFormat(),
  };
}

function buildDegradedPresentationInstructions(sessionKind: "spark" | undefined): string {
  if (sessionKind !== "spark") return DEGRADED_FINALIZATION_INSTRUCTIONS;
  return [
    ...SPARK_COMPANION_VOICE_INSTRUCTIONS,
    "For this failure response, identity and voice affect only the wording of failureNotice and nextStep. Keep the following neutral framing, language, factual limits and output schema exactly; do not add conversation, playfulness, proposals, work claims or action authority.",
    DEGRADED_FINALIZATION_INSTRUCTIONS,
  ].join("\n");
}
