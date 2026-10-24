import { isFiniteReasoningBudgetTokens, type ModelReasoningBudget } from "../../../shared/model-reasoning.js";
import { resolveModelGatewayFormat } from "../../structured-output/format-contract.js";
import type { ModelProviderInvocationParams } from "../contracts.js";
import { projectLlamaCppMessages } from "./message-projection.js";
import { projectLlamaCppFormat } from "./schema-format.js";

function nativeReasoningBudgetTokens(budget: ModelReasoningBudget): number {
  if (budget.mode === "server-default") return -1;
  if (!isFiniteReasoningBudgetTokens(budget.tokens)) throw new TypeError("llamacpp_reasoning_budget_invalid");
  return budget.tokens;
}

export function buildLlamaCppChatPayload(
  { requestBody, invocation, endpoint }: Pick<ModelProviderInvocationParams, "requestBody" | "invocation" | "endpoint">,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: invocation.model,
    messages: projectLlamaCppMessages(requestBody, invocation, endpoint),
    stream: true,
    stream_options: { include_usage: true },
    reasoning_format: "deepseek",
  };
  const generation = invocation.profile.generation;
  if (typeof generation.temperature === "number" && Number.isFinite(generation.temperature)) {
    payload.temperature = generation.temperature;
  }
  if (typeof generation.topP === "number" && Number.isFinite(generation.topP)) {
    payload.top_p = generation.topP;
  }
  const format = projectLlamaCppFormat(resolveModelGatewayFormat(requestBody.format, invocation.format));
  if (format) payload.response_format = format;
  if (invocation.think !== undefined) {
    payload.reasoning_effort = invocation.think;
    payload.chat_template_kwargs = { enable_thinking: invocation.think !== "none" };
  }
  const thinkingIsDisabled = invocation.think === "none";
  if (thinkingIsDisabled) {
    payload.reasoning_budget_tokens = 0;
    return payload;
  }
  if (invocation.reasoningBudget) {
    payload.reasoning_budget_tokens = nativeReasoningBudgetTokens(invocation.reasoningBudget);
    payload.chat_template_kwargs = { enable_thinking: true };
  }
  return payload;
}
