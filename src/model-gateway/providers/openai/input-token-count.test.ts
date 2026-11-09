import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createChatHandler,
  createInputTokenCountHandler,
  type GatewayResponse,
} from "../../server.js";
import { createInputTokenMeasurementStore } from "../../server/input-token-measurements.js";
import type { ModelGatewayRequest } from "../../types.js";
import { completedFunction, controlsFormat, frame } from "./__tests__/native-function-fixture.js";

function createResponse(): GatewayResponse & { body: string } {
  return {
    body: "",
    setHeader: vi.fn(),
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

const OPENAI_POLICY = {
  providers: {
    openai: {
      type: "openai",
      baseUrl: "https://openai-count.test/v1",
      apiKeyEnv: "TEST_OPENAI_COUNT_KEY",
    },
  },
  profiles: {
    luna: {
      provider: "openai",
      model: "gpt-test-luna",
      contextWindowTokens: 128_000,
      generation: { temperature: 0.2, topP: 0.9 },
    },
  },
  defaults: { profileId: "luna" },
} as const;

afterEach(() => {
  delete process.env.TEST_OPENAI_COUNT_KEY;
});

describe("OpenAI input token counting", () => {
  test("counts the final Responses input without generation-only controls", async () => {
    process.env.TEST_OPENAI_COUNT_KEY = "test-key";
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            object: "response.input_tokens",
            input_tokens: 4_321,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const handler = createInputTokenCountHandler({
      modelPolicy: OPENAI_POLICY,
      fetchImpl,
    });
    const response = createResponse();
    const format = {
      type: "json_schema",
      name: "answer",
      strict: true,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    };

    await handler(
      {
        messages: [{ role: "user", content: "Answer briefly." }],
        agentMode: "reasoning",
        modelStep: "supervisor.response",
        format,
      },
      response,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://openai-count.test/v1/responses/input_tokens");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
    const providerBody = JSON.parse(String(init?.body)) as Record<
      string,
      unknown
    >;
    expect(providerBody).toMatchObject({
      model: "gpt-test-luna",
      input: [{ role: "user", content: "Answer briefly." }],
    });
    expect(providerBody.text).toBeDefined();
    expect(providerBody).not.toHaveProperty("stream");
    expect(providerBody).not.toHaveProperty("temperature");
    expect(providerBody).not.toHaveProperty("top_p");
    expect(providerBody).not.toHaveProperty("max_output_tokens");
    expect(JSON.parse(response.body)).toEqual({
      inputTokens: 4_321,
      profileId: "luna",
      provider: "openai",
      model: "gpt-test-luna",
      contextWindowTokens: 128_000,
      source: "provider_input_token_count",
    });
  });

  test("counts the same ordered role, tool and repair inputs sent to Responses", async () => {
    process.env.TEST_OPENAI_COUNT_KEY = "test-key";
    const call = { callId: "read-1", name: "read_file", arguments: ' { "path": "שלום.txt" } ' };
    const receipt = "exact result\n";
    const policy = { role: "system", content: "Role policy." } as const;
    const reference = { role: "system", content: "Passive reference." } as const;
    const user = { role: "user", content: "Answer from the result." } as const;
    const repair = { role: "system", content: "Use the settled tool result." } as const;
    const request: ModelGatewayRequest = {
      modelStep: "capability.controls", format: controlsFormat,
      messages: [
        policy, reference, user,
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", content: receipt, toolCallId: call.callId, toolName: call.name },
        repair,
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ input_tokens: 21 }))
      .mockResolvedValueOnce(new Response(frame(completedFunction), {
        headers: { "Content-Type": "text/event-stream" },
      }));
    // A stale or unmatched measurement makes the final guard reject this envelope.
    const modelPolicy = {
      ...OPENAI_POLICY,
      profiles: { luna: { ...OPENAI_POLICY.profiles.luna, contextWindowTokens: 22 } },
    };
    const options = { modelPolicy, fetchImpl };
    const measurements = createInputTokenMeasurementStore();
    const count = createResponse();
    await createInputTokenCountHandler(options, measurements)(request, count);
    expect(JSON.parse(count.body).inputTokens).toBe(21);
    const output = createResponse();
    await createChatHandler(options, measurements)(request, output);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://openai-count.test/v1/responses/input_tokens",
      "https://openai-count.test/v1/responses",
    ]);
    const [countRequest, generationRequest] = fetchImpl.mock.calls;
    const counted = JSON.parse(String(countRequest![1]?.body));
    const dispatched = JSON.parse(String(generationRequest![1]?.body));
    expect(counted.input).toEqual([
      policy, reference, user,
      { type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.callId, output: receipt }, repair,
    ]);
    expect(counted.tools).toMatchObject([{ type: "function", name: controlsFormat.name, parameters: controlsFormat.schema }]);
    const { stream, temperature, top_p, ...generationInput } = dispatched;
    expect({ stream, temperature, top_p }).toEqual({ stream: true, temperature: 0.2, top_p: 0.9 });
    expect(generationInput).toEqual(counted);
    expect(output.body).toContain('"type":"done"');
  });
});
