import { isModelGatewayToolCall } from "../../protocol/message-contract.js";
import { isPlainObject } from "../../structured-output/format-contract.js";

type OpenAIFunctionResult = Readonly<{ text: string } | { error: string }>;

function isFunctionCall(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value.type === "function_call";
}

function hasCompletedResponseOutput(
  response: unknown,
): response is { status: "completed"; output: unknown[] } {
  if (!isPlainObject(response)) return false;
  if (response.status !== "completed") return false;
  return Array.isArray(response.output);
}

// Only the terminal response snapshot is authoritative. Argument deltas and
// output_item.done may precede refusal, truncation or a failed response.
export function readOpenAIFunctionResult(
  response: unknown,
  expectedName: string,
): OpenAIFunctionResult {
  if (!hasCompletedResponseOutput(response)) {
    return { error: "openai function response not completed" };
  }
  const calls = response.output.filter(isFunctionCall);
  if (calls.length !== 1) {
    return { error: "openai function response requires exactly one call" };
  }
  const call = calls[0]!;
  if (call.name !== expectedName) {
    return { error: "openai function response name mismatch" };
  }
  if (call.status !== undefined && call.status !== "completed") {
    return { error: "openai function call not completed" };
  }
  const projected = { callId: call.call_id, name: call.name, arguments: call.arguments };
  if (!isModelGatewayToolCall(projected)) {
    return { error: "openai function call arguments or identity invalid" };
  }
  return { text: projected.arguments };
}
