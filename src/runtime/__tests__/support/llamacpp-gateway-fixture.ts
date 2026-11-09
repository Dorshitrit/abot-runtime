import { expect, vi } from "vitest";
import { createModelGatewayClient } from "../../../model-gateway/client.js";
import { createChatHandler } from "../../../model-gateway/server/chat-handler.js";
import type { GatewayResponse } from "../../../model-gateway/server/contracts.js";
import { createInputTokenCountHandler } from "../../../model-gateway/server/input-token-count-handler.js";
import { createInputTokenMeasurementStore } from "../../../model-gateway/server/input-token-measurements.js";
import { renderLlamaCppTemplate, type TemplateMode } from "../../../model-gateway/providers/llamacpp/__tests__/render-template-fixture.js";
import type { ChatMessage, ModelGatewayPolicyConfig } from "../../../model-gateway/types.js";
import { INVALID_OUTPUT_MODEL_POLICY } from "./root-invalid-output-fixture.js";

export const modelPolicy: ModelGatewayPolicyConfig = {
  ...INVALID_OUTPUT_MODEL_POLICY, providers: { test: { type: "llamacpp", baseUrl: "http://provider.test" } },
};
type Envelope = { modelStep?: string; format?: { name?: string }; messages: ChatMessage[]; invocationContextMessageIndices?: number[] };
export type Exchange = {
  path: string; request: Envelope; upstream: { path: string; payload: Envelope }[];
  rejection?: { status: number; reason: string };
};

export type GatewayReply = string | ((input: Envelope) => string);

export function createGateway(template: TemplateMode, replies: GatewayReply[]) {
  const exchanges: Exchange[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const payload: Envelope = JSON.parse(String(init?.body));
    exchanges.at(-1)!.upstream.push({ path, payload });
    if (path === "/apply-template") return Response.json({ prompt: renderLlamaCppTemplate(payload.messages, template) });
    if (path === "/v1/chat/completions/input_tokens") return Response.json({ input_tokens: 123 });
    expect(path).toBe("/v1/chat/completions");
    const reply = replies.shift();
    if (reply === undefined) throw new Error("Unexpected extra generation");
    const content = typeof reply === "string" ? reply : reply(exchanges.at(-1)!.request);
    const chunk = { choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  };
  const measurements = createInputTokenMeasurementStore();
  const options = { modelPolicy, fetchImpl };
  const count = createInputTokenCountHandler(options, measurements);
  const chat = createChatHandler(options, measurements);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    expect(["/input-tokens", "/chat"]).toContain(path);
    const request: Envelope = JSON.parse(String(init.body));
    const exchange: Exchange = { path, request, upstream: [] };
    exchanges.push(exchange);
    const output: GatewayResponse & { body: string } = {
      body: "", setHeader() {}, write(text) { this.body += text; }, end(text = "") { this.body += text; },
    };
    await (path === "/chat" ? chat : count)(request, output, { abortSignal: init.signal ?? undefined });
    const status = output.statusCode ?? 200;
    if (status >= 400) exchange.rejection = { status, reason: output.body };
    return new Response(output.body, { status });
  });
  return { exchanges, client: createModelGatewayClient({ baseUrl: "http://gateway.test", modelPolicy }) };
}
