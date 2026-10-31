import type { ChatMessage, ModelGatewayRequest } from "../../../types.js";
import { resolveModelInvocation } from "../../../policy/invocation-policy.js";
import { createChatGptProviderAdapter } from "../adapter.js";
import { frame } from "../../openai/__tests__/native-function-fixture.js";

export const accountRef = "12345678-1234-4123-8123-123456789abc";
export const messages: ChatMessage[] = [
  { role: "system", content: "Keep the caller's policy." },
  { role: "user", content: "Hello שלום" },
];
export const request: ModelGatewayRequest = {
  messages,
  modelPolicy: {
    providers: { plan: { type: "openai-chatgpt", settings: { accountRef } } },
    profiles: { plan: { provider: "plan", model: "fixture", contextWindowTokens: 32768,
      supportsThinking: true, generation: { temperature: 0.5, topP: 0.9 } } },
    defaults: { profileId: "plan" },
  },
};
export const finalMessage = {
  type: "message", id: "final", phase: "final_answer", status: "completed",
  content: [{ type: "output_text", text: "answer" }],
};
export const completed = { type: "response.completed", response: { status: "completed", output: [finalMessage] } };
export function response(events: readonly unknown[], suffix = ""): Response {
  return new Response(events.map(frame).join("") + suffix, { headers: { "Content-Type": "text/event-stream" } });
}
export function invoke(
  fetchImpl: typeof fetch,
  requestBody = request,
  endpoint: "raw" | "chat" = "raw",
  abortSignal?: AbortSignal,
  getAccessToken = async (_accountRef: string, _signal?: AbortSignal) => "test-only-plan-token",
) {
  return createChatGptProviderAdapter({ getAccessToken }).invoke({
    endpoint, requestBody, invocation: resolveModelInvocation(requestBody), fetchImpl,
    ...(abortSignal ? { abortSignal } : {}),
  });
}
