import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createInputTokenCountHandler,
  type GatewayResponse,
} from "../../server.js";

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
});
