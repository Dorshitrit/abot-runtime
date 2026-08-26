import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
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
}): {
  messages: ChatMessage[];
  format: ReturnType<typeof createDegradedFinalizationFormat>;
} {
  return {
    messages: [
      {
        role: "system",
        content: DEGRADED_FINALIZATION_INSTRUCTIONS,
      },
      {
        role: "user",
        content: buildDegradedFinalizationUserPrompt({
          requestText: params.request.prompt,
          problemText: JSON.stringify(params.input.problem, null, 2),
        }),
      },
    ],
    format: createDegradedFinalizationFormat(),
  };
}
