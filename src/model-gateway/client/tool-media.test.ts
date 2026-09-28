import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage, ModelGatewayRequest } from "../types.js";
import { buildOpenAIResponsesPayload } from "../providers/openai.js";
import { buildOllamaPayload } from "../providers/ollama.js";
import { createOpenAIProviderAdapter } from "../providers/openai/adapter.js";
import { validateModelGatewayMessages } from "../message-contract.js";
import { resolveRequestMessages } from "./message-projection.js";
import { countModelGatewayInputTokensWithOptions } from "./input-token-count.js";
import { toolImageFixture, toolImageMessages } from "../../runtime/__tests__/support/tool-media-fixture.js";
import { RequestToolMediaStore } from "../../runtime/attachments/request-tool-media.js";
import { projectToolMediaMessages } from "../../runtime/context/tool-media-projection.js";

afterEach(() => vi.unstubAllGlobals());

async function imageMessages(lane: "root" | "worker") {
  const store = new RequestToolMediaStore();
  const execution = store.beginExecution({ callId: "call-1", executionId: "execution-1" }, new AbortController().signal);
  const reference = await execution.writer.writeImage({ bytes: toolImageFixture(), mimeType: "image/png" });
  execution.finish([reference]);
  const messages = projectToolMediaMessages({ messages: toolImageMessages(reference, lane), store, modelStep: lane === "root" ? "execution.decision" : "worker.decision", supportsImages: true });
  store.dispose();
  return messages;
}

function request(provider: "ollama" | "openai", messages: ChatMessage[]): ModelGatewayRequest {
  return { messages, modelStep: "execution.decision", modelPolicy: {
    providers: { [provider]: { type: provider } },
    profiles: { fixture: { provider, model: "fixture", contextWindowTokens: 64000, capabilities: { inputModalities: ["text", "image"] } } },
    defaults: { profileId: "fixture" },
  } };
}

test.each(["root", "worker"] as const)("%s pixels survive client validation and reach both provider payloads in the original evidence lane", async (lane) => {
  const messages = await imageMessages(lane);
  expect(resolveRequestMessages({ messages })).toEqual(messages);
  const openai = buildOpenAIResponsesPayload(request("openai", messages)).input as Record<string, unknown>[];
  const ollama = buildOllamaPayload(request("ollama", messages)).messages as Record<string, unknown>[];
  const pixels = toolImageFixture().toString("base64");
  expect(ollama.at(-1)).toMatchObject({ role: lane === "root" ? "tool" : "user", content: messages.at(-1)!.content, images: [pixels] });
  const contents = [
    { type: "input_text", text: messages.at(-1)!.content },
    { type: "input_image", image_url: `data:image/png;base64,${pixels}`, detail: "auto" },
  ];
  expect(openai.at(-1)).toEqual(lane === "root"
    ? { type: "function_call_output", call_id: "execution-1", output: contents }
    : { role: "user", content: contents });
  expect(openai).toHaveLength(messages.length);
  expect(ollama).toHaveLength(messages.length);
  expect(createOpenAIProviderAdapter().supportsImageInput).toBe(true);
});

test("native tool images cannot be rebound to another execution", async () => {
  const messages = await imageMessages("root");
  messages.at(-1)!.attachments![0]!.toolEvidence = { executionId: "unrelated" };
  expect(() => validateModelGatewayMessages(messages)).toThrow("model_gateway_tool_interaction_invalid");
});

test("input token failure cannot echo tool pixels into upstream error traces", async () => {
  const messages = await imageMessages("root");
  const pixels = toolImageFixture().toString("base64");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`provider echoed ${pixels}`, { status: 400 })));
  await expect(countModelGatewayInputTokensWithOptions({
    messages, provider: "openai", agentMode: "reasoning", abortSignal: new AbortController().signal,
  }, { inputTokenCountProviders: ["openai"] })).rejects.toThrow("bridge_input_token_count_failed:400:tool_media_provider_error: content omitted");
});
