import type { ModelGatewayRequest } from "../../types.js";
import { buildOpenAIResponsesPayload, type OpenAIPayloadBuildOptions } from "../openai/payload.js";

function projectChatGptInput(input: unknown): unknown[] {
  if (!Array.isArray(input)) return [{ role: "user", content: input }];
  return input.map((item: Record<string, unknown>) =>
    item.role === "system" ? { ...item, role: "developer" } : item,
  );
}

/** Project only the SIWC wire contract; canonical roles and evidence stay intact. */
export function buildChatGptResponsesPayload(
  request: ModelGatewayRequest,
  options: OpenAIPayloadBuildOptions = {},
): Record<string, unknown> {
  const responses = buildOpenAIResponsesPayload(request, options);
  const input = projectChatGptInput(responses.input);
  if (responses.tools) {
    input.push({ type: "additional_tools", role: "developer", tools: responses.tools });
  }
  const payload: Record<string, unknown> = {
    model: responses.model, input, stream: true, store: false,
  };
  for (const key of ["reasoning", "text", "tool_choice", "parallel_tool_calls"]) {
    if (Object.hasOwn(responses, key)) payload[key] = responses[key];
  }
  return payload;
}
