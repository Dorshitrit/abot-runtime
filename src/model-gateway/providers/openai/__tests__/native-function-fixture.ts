import type { ModelGatewayRequest } from "../../../types.js";

export const controlsFormat = {
  type: "json_schema", name: "execution_capability_controls", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["decision"],
    properties: { decision: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: { path: { type: "string" } },
    } },
  },
} as const;
export const nativeRequest: ModelGatewayRequest = {
  modelStep: "capability.controls", format: controlsFormat,
  messages: [{ role: "user", content: "Prepare the selected operation." }],
  modelPolicy: {
    providers: { test: { type: "openai", baseUrl: "https://native.test/v1", apiKeyEnv: "NATIVE_TEST_KEY" } },
    profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32768, supportsThinking: true } },
    defaults: { profileId: "test" },
  },
};
export const functionArguments = JSON.stringify({ decision: { path: "שלום/file.txt" } });
export const functionCall = {
  type: "function_call", id: "fc_1", call_id: "call_1", status: "completed",
  name: controlsFormat.name, arguments: functionArguments,
};
export const completedFunction = { type: "response.completed", response: {
  status: "completed", output: [functionCall],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
} };
export const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
export const preamble = [
  { type: "response.output_item.added", output_index: 0,
    item: { type: "message", id: "preamble", phase: "commentary" } },
  { type: "response.output_text.delta", item_id: "preamble", output_index: 0,
    delta: '{"decision":"do not use text"}' },
  { type: "response.output_item.added", output_index: 1,
    item: { ...functionCall, status: "in_progress", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: functionCall.id,
    output_index: 1, delta: functionArguments },
  { type: "response.function_call_arguments.done", item_id: functionCall.id,
    output_index: 1, arguments: functionArguments },
  { type: "response.output_item.done", output_index: 1, item: functionCall },
];
export function sse(events: readonly unknown[], suffix = ""): ReadableStream<Uint8Array> {
  return new Response(events.map(frame).join("") + suffix).body!;
}
