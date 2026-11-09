import { expect, test } from "vitest";
import { buildRequestTemporalContextMessage } from "../../runtime/context/request-temporal-context.js";
import { buildOllamaPayload } from "../providers/ollama/payload.js";
import { buildChatGptResponsesPayload } from "../providers/openai-chatgpt/payload.js";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "../providers/openai/payload.js";
import type { ModelGatewayPolicyConfig } from "../types.js";
import { projectChatGatewayMessages } from "./message-projection.js";

const time = buildRequestTemporalContextMessage({ currentDateTime: "2026-11-05", timeZone: "UTC" });
const receipt = { role: "user" as const, content: "progress" };
const repair = { role: "system" as const, content: "correct the previous result" };

test("binds only producer objects after legacy normalization and a final user prompt", () => {
  const copy = { ...time };
  const projected = projectChatGatewayMessages({ messages: [null, receipt, copy, time, repair], text: "continue" });
  expect(projected.messages).toEqual([receipt, copy, time, repair, { role: "user", content: "continue" }]);
  expect(projected.invocationContextMessageIndices).toEqual([2]);
  expect(projectChatGatewayMessages({ messages: [copy, receipt, repair] })).toEqual({ messages: [copy, receipt, repair] });
});

test.each([
  ["ollama", buildOllamaPayload],
  ["openai", buildOpenAIInputTokenCountPayload],
  ["openai", buildOpenAIResponsesPayload],
  ["openai-chatgpt", buildChatGptResponsesPayload],
] as const)("%s provider payload preserves the original projection", (provider, build) => {
  const modelPolicy: ModelGatewayPolicyConfig = {
    providers: { fixture: { type: provider } },
    profiles: { fixture: { provider: "fixture", model: "test-model", contextWindowTokens: 32_000 } },
    defaults: { profileId: "fixture" },
  };
  const projection = projectChatGatewayMessages({ messages: [receipt, time, repair] });
  expect(projection.invocationContextMessageIndices).toEqual([1]);
  const original = build({ messages: projection.messages, modelPolicy });
  expect(build({ ...projection, modelPolicy })).toEqual(original);
  expect(original).not.toHaveProperty("invocationContextMessageIndices");
});
