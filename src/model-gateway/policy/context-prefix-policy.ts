import { MODEL_STEPS } from "../../shared/model-steps.js";
import { resolveModelInvocation } from "./invocation-policy.js";
import type { ModelGatewayRequest } from "../types.js";
import { isOpenAIPromptCacheEnabled } from "../providers/openai/prompt-cache.js";

/** Keep this opt-in at the resolved provider boundary, not in message parsing. */
export function shouldUseStableExecutionContextPrefix(request: ModelGatewayRequest): boolean {
  if (request.modelStep !== MODEL_STEPS.EXECUTION_DECISION) return false;
  const { profile } = resolveModelInvocation(request);
  return profile.provider === "openai" && isOpenAIPromptCacheEnabled(profile.options);
}
