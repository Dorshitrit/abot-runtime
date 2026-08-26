import { describe, expect, test } from "vitest";

import {
  resolveConfiguredInvocationProfile,
  resolveEffectiveInvocationProfile,
} from "./invocation-profile-policy.js";
import { listModelProfiles } from "./model-registry.js";
import {
  ModelInvocationResolutionError,
  resolveModelInvocation,
} from "./invocation-policy.js";
import {
  buildOllamaPayload,
  buildOllamaRawPayload,
} from "../providers/ollama.js";
import {
  buildOpenAIResponsesPayload,
  collectOpenAIResponsesStream,
  forwardOpenAIResponsesStream,
} from "../providers/openai.js";
import type { ModelProviderEventSink } from "../provider-adapter.js";
import { MODEL_STEPS } from "../../shared/model-steps.js";

const OLLAMA_TEST_PROVIDERS = {
  ollama: { type: "ollama" as const },
};
const OPENAI_TEST_PROVIDERS = {
  openai: { type: "openai" as const },
};

const OLLAMA_TEST_POLICY = {
  providers: OLLAMA_TEST_PROVIDERS,
  profiles: {
    configured: {
      provider: "ollama",
      model: "configured-model",
      contextWindowTokens: 32_768,
      supportsThinking: true,
    },
  },
  defaults: {
    profileId: "configured",
  },
};

function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(events.join("")));
      controller.close();
    },
  });
}

function serializedEventSink(chunks: string[]): ModelProviderEventSink {
  return {
    emit(event) {
      chunks.push(`${JSON.stringify(event)}\n`);
    },
  };
}

function createOpenAIMessageOutputEvents(
  outputs: readonly Readonly<{
    itemId: string;
    outputIndex: number;
    text: string;
  }>[],
): string[] {
  return [
    ...outputs.map(
      ({ itemId, outputIndex, text }) =>
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: outputIndex,
          delta: text,
        })}\n\n`,
    ),
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {},
    })}\n\n`,
  ];
}

describe("model gateway invocation policy", () => {
  test("exposes no model profiles without an explicit policy catalog", () => {
    expect(listModelProfiles()).toEqual([]);
  });

  test("rejects an invocation when policy cannot resolve a configured profile", () => {
    expect(() => resolveModelInvocation({ agentMode: "deep" })).toThrow(
      ModelInvocationResolutionError,
    );
    expect(() => resolveModelInvocation({ agentMode: "deep" })).toThrow(
      "model_profile_required: model policy must resolve an effective configured profile",
    );
  });

  test("rejects an explicitly requested unknown model profile", () => {
    expect(() =>
      resolveModelInvocation({
        modelPolicy: OLLAMA_TEST_POLICY,
        modelPreference: { profileId: "not-configured" },
      }),
    ).toThrow(
      "unknown_model_profile: requested profile not-configured is not available in model policy",
    );
  });

  test("overlays modelOverride on the configured profile without changing policy", () => {
    const invocation = resolveModelInvocation({
      agentMode: "deep",
      modelOverride: "provider-model-override",
      modelPolicy: {
        providers: {
          local: {
            type: "ollama",
            baseUrl: "http://configured-provider.test",
          },
        },
        profiles: {
          primary: {
            provider: "local",
            model: "configured-model",
            contextWindowTokens: 8_192,
            supportsThinking: true,
            options: { num_ctx: 8192 },
            generation: { temperature: 0.25 },
            capabilities: {
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
            },
          },
        },
        defaults: { profileId: "primary" },
      },
    });

    expect(invocation).toMatchObject({
      model: "provider-model-override",
      think: "high",
      profile: {
        id: "primary",
        providerId: "local",
        provider: "ollama",
        providerConfig: {
          baseUrl: "http://configured-provider.test",
        },
        model: "provider-model-override",
        options: { num_ctx: 8192 },
        generation: { temperature: 0.25 },
        capabilities: {
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
      },
    });
  });

  test("changes reasoning without changing the configured model profile", () => {
    const fast = resolveModelInvocation({
      agentMode: "fast",
      modelPolicy: OLLAMA_TEST_POLICY,
    });
    const reasoning = resolveModelInvocation({
      agentMode: "reasoning",
      modelPolicy: OLLAMA_TEST_POLICY,
    });
    const deep = resolveModelInvocation({
      agentMode: "deep",
      modelPolicy: OLLAMA_TEST_POLICY,
    });

    expect(fast).toMatchObject({
      model: "configured-model",
      profile: { id: "configured" },
      think: "none",
    });
    expect(reasoning).toMatchObject({
      model: "configured-model",
      profile: { id: "configured" },
      think: "medium",
    });
    expect(deep).toMatchObject({
      model: "configured-model",
      profile: { id: "configured" },
      think: "high",
    });
  });

  test("disables Ollama thinking for fast mode", () => {
    expect(
      buildOllamaPayload({
        agentMode: "fast",
        modelPolicy: OLLAMA_TEST_POLICY,
      }).think,
    ).toBe(false);
    expect(
      buildOllamaPayload({
        agentMode: "reasoning",
        modelPolicy: OLLAMA_TEST_POLICY,
      }).think,
    ).toBe("medium");
    expect(
      buildOllamaPayload({
        agentMode: "deep",
        modelPolicy: OLLAMA_TEST_POLICY,
      }).think,
    ).toBe("high");
  });

  test("adds trusted image data to Ollama chat messages at provider boundary", () => {
    const data = Buffer.from([1, 2, 3, 4]).toString("base64");
    const payload = buildOllamaPayload({
      modelPolicy: OLLAMA_TEST_POLICY,
      messages: [
        {
          role: "user",
          content: "describe",
          attachments: [
            {
              id: "att-1",
              kind: "image",
              mimeType: "image/png",
              storageRef: "session/request/image.png",
              data,
            },
          ],
        },
      ],
    });

    expect(payload.messages).toEqual([
      {
        role: "user",
        content: "describe",
        images: [data],
      },
    ]);
  });

  test("ignores client-supplied attachment paths at provider boundary", () => {
    const payload = buildOllamaPayload({
      modelPolicy: OLLAMA_TEST_POLICY,
      messages: [
        {
          role: "user",
          content: "describe",
          attachments: [
            {
              id: "att-1",
              kind: "image",
              mimeType: "image/png",
              storageRef: "session/request/image.png",
              path: "/etc/passwd",
            },
          ],
        },
      ],
    });

    expect(payload.messages).toEqual([
      {
        role: "user",
        content: "describe",
      },
    ]);
  });

  test("omits OpenAI reasoning payload when reasoning is disabled", () => {
    const payload = buildOpenAIResponsesPayload({
      agentMode: "fast",
      modelPolicy: {
        providers: OPENAI_TEST_PROVIDERS,
        profiles: {
          "test-openai": {
            provider: "openai",
            model: "gpt-test",
            contextWindowTokens: 32_768,
            supportsThinking: true,
          },
        },
        defaults: {
          profileId: "test-openai",
        },
      },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("max_output_tokens");
  });

  test("enforces the fixed output limit only for registered core decisions in OpenAI", () => {
    const buildPayload = (modelStep: string, contextWindowTokens = 32_768) =>
      buildOpenAIResponsesPayload({
        modelStep,
        messages: [{ role: "user", content: "Choose the next action." }],
        modelPolicy: {
          providers: OPENAI_TEST_PROVIDERS,
          profiles: {
            "test-openai": {
              provider: "openai",
              model: "gpt-test",
              contextWindowTokens,
            },
          },
          defaults: {
            profileId: "test-openai",
          },
        },
      });

    expect(buildPayload(MODEL_STEPS.WORKER_DECISION)).toHaveProperty(
      "max_output_tokens",
      2_048,
    );
    expect(buildPayload(MODEL_STEPS.WORKER_RESULT)).not.toHaveProperty(
      "max_output_tokens",
    );
    expect(buildPayload("unregistered.decision")).not.toHaveProperty(
      "max_output_tokens",
    );
    expect(
      buildPayload(MODEL_STEPS.WORKER_DECISION, 64).max_output_tokens,
    ).toBeLessThan(2_048);
  });

  test("lets an explicit reasoning override replace profile generation defaults", () => {
    const payload = buildOpenAIResponsesPayload({
      agentMode: "deep",
      reasoningOverride: "none",
      modelPolicy: {
        providers: OPENAI_TEST_PROVIDERS,
        profiles: {
          "test-openai": {
            provider: "openai",
            model: "gpt-test",
            contextWindowTokens: 32_768,
            supportsThinking: true,
            generation: {
              reasoningEffort: "minimal",
            },
          },
        },
        defaults: {
          profileId: "test-openai",
        },
      },
    });

    expect(payload).not.toHaveProperty("reasoning");
  });

  test("applies calibrated reasoning effort to Ollama model steps", () => {
    const payload = buildOllamaPayload({
      agentMode: "reasoning",
      modelStep: "planner.decision",
      modelPreference: {
        profileId: "gemma-test",
        scope: "all",
      },
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          "gemma-test": {
            provider: "ollama",
            model: "gemma-test-model",
            contextWindowTokens: 32_768,
            supportsThinking: true,
            calibration: {
              "planner.decision": {
                generation: {
                  reasoningEffort: "none",
                },
              },
            },
          },
        },
        defaults: {
          steps: {
            "planner.decision": "planner.decision",
          },
        },
      },
    });

    expect(payload.think).toBe(false);
  });

  test("applies provider config to configured profiles", () => {
    const invocation = resolveModelInvocation({
      modelPolicy: {
        providers: {
          ollama: {
            type: "ollama",
            baseUrl: "http://configured-ollama.test",
          },
        },
        profiles: {
          "gemma-e4b": {
            provider: "ollama",
            model: "configured-gemma-model",
            contextWindowTokens: 32_768,
          },
        },
        defaults: {
          profileId: "gemma-e4b",
        },
      },
    });

    expect(invocation.profile.providerConfig?.baseUrl).toBe(
      "http://configured-ollama.test",
    );
  });

  test("resolves configured invocation profiles by step before role and default", () => {
    const modelPolicy = {
      providers: OLLAMA_TEST_PROVIDERS,
      profiles: {
        default: {
          provider: "ollama",
          model: "default-model",
          contextWindowTokens: 32_768,
        },
        planner: {
          provider: "ollama",
          model: "planner-model",
          contextWindowTokens: 32_768,
        },
        review: {
          provider: "ollama",
          model: "review-model",
          contextWindowTokens: 32_768,
        },
      },
      defaults: {
        profileId: "default",
        roles: {
          planner: "planner",
        },
        steps: {
          "worker.decision": "review",
        },
      },
    };

    expect(
      resolveConfiguredInvocationProfile({
        taskType: "development",
        modelStep: "worker.decision",
        modelPolicy,
      })?.profileId,
    ).toBe("review");
    expect(
      resolveConfiguredInvocationProfile({
        taskType: "development",
        modelStep: "planner.decision",
        modelPolicy,
      })?.profileId,
    ).toBe("planner");
    expect(
      resolveConfiguredInvocationProfile({
        modelStep: "degraded.finalization",
        modelPolicy,
      })?.profileId,
    ).toBe("default");
  });

  test("preserves client preference precedence unless config overrides it", () => {
    const modelPolicy = {
      providers: OLLAMA_TEST_PROVIDERS,
      profiles: {
        configured: {
          provider: "ollama",
          model: "configured-model",
          contextWindowTokens: 32_768,
        },
        preferred: {
          provider: "ollama",
          model: "preferred-model",
          contextWindowTokens: 32_768,
        },
      },
      defaults: {
        profileId: "configured",
      },
    };

    expect(
      resolveEffectiveInvocationProfile({
        modelStep: "supervisor.decision",
        modelPreference: { profileId: "preferred", scope: "main" },
        modelPolicy,
      })?.profileId,
    ).toBe("preferred");
    expect(
      resolveEffectiveInvocationProfile({
        modelStep: "supervisor.decision",
        modelPreference: { profileId: "preferred", scope: "main" },
        modelPolicy: {
          ...modelPolicy,
          defaults: {
            ...modelPolicy.defaults,
            overrideClientPreference: true,
          },
        },
      })?.profileId,
    ).toBe("configured");
  });

  test("resolves a preferred invocation-profile alias to its canonical base profile", () => {
    const modelPolicy = {
      providers: OLLAMA_TEST_PROVIDERS,
      profiles: {
        configured: {
          provider: "ollama",
          model: "configured-model",
          contextWindowTokens: 32_768,
        },
        preferred: {
          provider: "ollama",
          model: "preferred-model",
          contextWindowTokens: 32_768,
        },
      },
      invocationProfiles: {
        "preferred-alias": {
          profileId: "preferred",
          generation: { temperature: 0.2 },
        },
      },
      defaults: {
        profileId: "configured",
      },
    };

    expect(
      resolveEffectiveInvocationProfile({
        modelStep: "supervisor.decision",
        modelPreference: { profileId: "preferred-alias", scope: "main" },
        modelPolicy,
      }),
    ).toMatchObject({
      profileId: "preferred",
      invocationProfileId: "preferred-alias",
    });
    expect(
      resolveModelInvocation({
        agentMode: "reasoning",
        modelStep: "supervisor.decision",
        modelPreference: { profileId: "preferred-alias", scope: "main" },
        modelPolicy,
      }),
    ).toMatchObject({
      model: "preferred-model",
      profile: {
        id: "preferred",
        generation: { temperature: 0.2 },
      },
    });
  });

  test("applies invocation profile generation, context, and format overlays", () => {
    const payload = buildOllamaPayload({
      agentMode: "reasoning",
      modelStep: "degraded.finalization",
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          base: {
            provider: "ollama",
            model: "base-model",
            contextWindowTokens: 4_096,
            options: {
              temperature: 1,
            },
            generation: {
              temperature: 0.9,
              topP: 0.95,
            },
          },
        },
        invocationProfiles: {
          compactJson: {
            profileId: "base",
            generation: {
              temperature: 0.2,
            },
            format: "json",
          },
        },
        defaults: {
          steps: {
            "degraded.finalization": "compactJson",
          },
        },
      },
    });

    expect(payload).toMatchObject({
      model: "base-model",
      format: "json",
      options: {
        temperature: 0.2,
        top_p: 0.95,
        num_ctx: 4096,
      },
    });
    expect(payload).toHaveProperty("options.num_predict", expect.any(Number));
    expect(
      (payload.options as Record<string, number>).num_predict,
    ).toBeLessThan(4096);
  });

  test("applies selected model calibration slots from model step mappings", () => {
    const payload = buildOllamaPayload({
      agentMode: "reasoning",
      modelStep: "supervisor.decision",
      modelPreference: {
        profileId: "preferred",
        scope: "all",
      },
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          default: {
            provider: "ollama",
            model: "default-model",
            contextWindowTokens: 32_768,
            generation: {
              temperature: 0.9,
            },
          },
          preferred: {
            provider: "ollama",
            model: "preferred-model",
            contextWindowTokens: 18_000,
            generation: {
              temperature: 0.8,
              topP: 0.95,
            },
            calibration: {
              "supervisor.decision": {
                generation: {
                  temperature: 0.15,
                },
                format: "json",
              },
            },
          },
        },
        defaults: {
          profileId: "default",
          steps: {
            "supervisor.decision": "supervisor.decision",
          },
        },
      },
    });

    expect(payload).toMatchObject({
      model: "preferred-model",
      format: "json",
      options: {
        temperature: 0.15,
        top_p: 0.95,
        num_ctx: 18000,
      },
    });
    expect(payload).toHaveProperty("options.num_predict", expect.any(Number));
    expect(
      (payload.options as Record<string, number>).num_predict,
    ).toBeLessThan(18000);
  });

  test("caps the declared Ollama context window at explicit num_ctx", () => {
    const payload = buildOllamaPayload({
      modelStep: "supervisor.decision",
      modelPolicy: {
        providers: {
          ollama: {
            type: "ollama",
            keepAlive: "15m",
          },
        },
        profiles: {
          local: {
            provider: "ollama",
            model: "local-model",
            contextWindowTokens: 64_000,
            options: {
              num_ctx: 32768,
            },
          },
        },
        defaults: {
          profileId: "local",
        },
      },
    });

    expect(payload).toMatchObject({
      keep_alive: "15m",
      options: {
        num_ctx: 32768,
      },
    });
  });

  test("keeps provider-native Ollama num_predict and its environment override", () => {
    const previousNumPredict = process.env.OLLAMA_NUM_PREDICT;
    const buildPayload = () =>
      buildOllamaPayload({
        modelPolicy: {
          providers: OLLAMA_TEST_PROVIDERS,
          profiles: {
            local: {
              provider: "ollama",
              model: "local-model",
              contextWindowTokens: 32_768,
              options: {
                num_predict: 640,
              },
            },
          },
          defaults: {
            profileId: "local",
          },
        },
      });

    try {
      delete process.env.OLLAMA_NUM_PREDICT;
      expect(buildPayload()).toHaveProperty("options.num_predict", 640);

      process.env.OLLAMA_NUM_PREDICT = "960";
      expect(buildPayload()).toHaveProperty("options.num_predict", 960);
    } finally {
      if (previousNumPredict === undefined) {
        delete process.env.OLLAMA_NUM_PREDICT;
      } else {
        process.env.OLLAMA_NUM_PREDICT = previousNumPredict;
      }
    }
  });

  test("enforces the core decision output limit ahead of Ollama overrides", () => {
    const previousNumPredict = process.env.OLLAMA_NUM_PREDICT;
    const buildPayload = (modelStep: string) =>
      buildOllamaPayload({
        modelStep,
        modelPolicy: {
          providers: OLLAMA_TEST_PROVIDERS,
          profiles: {
            local: {
              provider: "ollama",
              model: "local-model",
              contextWindowTokens: 32_768,
              options: {
                num_predict: 640,
              },
            },
          },
          defaults: {
            profileId: "local",
          },
        },
      });

    try {
      delete process.env.OLLAMA_NUM_PREDICT;
      expect(buildPayload(MODEL_STEPS.WORKER_DECISION)).toHaveProperty(
        "options.num_predict",
        2_048,
      );

      process.env.OLLAMA_NUM_PREDICT = "960";
      expect(buildPayload(MODEL_STEPS.WORKER_DECISION)).toHaveProperty(
        "options.num_predict",
        2_048,
      );
      expect(buildPayload(MODEL_STEPS.WORKER_RESULT)).toHaveProperty(
        "options.num_predict",
        960,
      );
    } finally {
      if (previousNumPredict === undefined) {
        delete process.env.OLLAMA_NUM_PREDICT;
      } else {
        process.env.OLLAMA_NUM_PREDICT = previousNumPredict;
      }
    }
  });

  test("keeps a core decision below its physical Ollama remainder", () => {
    const payload = buildOllamaRawPayload({
      modelStep: MODEL_STEPS.WORKER_DECISION,
      prompt: "x".repeat(12_000),
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          local: {
            provider: "ollama",
            model: "local-model",
            contextWindowTokens: 4_096,
          },
        },
        defaults: {
          profileId: "local",
        },
      },
    });

    expect(
      (payload.options as Record<string, number>).num_predict,
    ).toBeLessThan(2_048);
  });

  test("derives finite Ollama generation capacity from the final envelope", () => {
    const buildPayload = (prompt: string) =>
      buildOllamaRawPayload({
        prompt,
        modelPolicy: {
          providers: OLLAMA_TEST_PROVIDERS,
          profiles: {
            local: {
              provider: "ollama",
              model: "local-model",
              contextWindowTokens: 4_096,
            },
          },
          defaults: {
            profileId: "local",
          },
        },
      });

    const shortPayload = buildPayload("short input");
    const longPayload = buildPayload("x".repeat(2_000));
    const shortLimit = (shortPayload.options as Record<string, number>)
      .num_predict;
    const longLimit = (longPayload.options as Record<string, number>)
      .num_predict;

    expect(shortLimit).toBeGreaterThan(0);
    expect(shortLimit).toBeLessThan(4_096);
    expect(longLimit).toBeGreaterThan(0);
    expect(longLimit).toBeLessThan(shortLimit);
  });

  test("bounds non-thinking structured output by its strict schema", () => {
    const payload = buildOllamaPayload({
      agentMode: "fast",
      format: {
        type: "json_schema",
        name: "bounded_output",
        strict: true,
        postValidatedSchemaConstraints: [
          {
            keyword: "maxLength",
            path: "/properties/value/maxLength",
          },
        ],
        schema: {
          type: "object",
          properties: {
            value: { type: "string", maxLength: 100 },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          local: {
            provider: "ollama",
            model: "local-model",
            contextWindowTokens: 4_096,
            supportsThinking: true,
          },
        },
        defaults: {
          profileId: "local",
        },
      },
    });

    expect(payload).toHaveProperty("options.num_predict", 57);
  });

  test("adapts an explicit runtime schema ahead of calibrated JSON mode for each provider", () => {
    const decisionSchema = {
      type: "json_schema" as const,
      name: "runtime_decision_envelope",
      strict: false,
      schema: {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["tool"] },
              tool: { type: "string", enum: ["inspect_state"] },
            },
            required: ["kind", "tool"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["final"] },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        ],
      },
    };
    const buildPolicy = (provider: "ollama" | "openai") => ({
      providers: {
        [provider]: { type: provider },
      },
      profiles: {
        preferred: {
          provider,
          model: `${provider}-model`,
          contextWindowTokens: 32_768,
          calibration: {
            "supervisor.decision": {
              format: "json" as const,
            },
          },
        },
      },
      defaults: {
        profileId: "preferred",
        steps: {
          "supervisor.decision": "supervisor.decision",
        },
      },
    });

    const ollamaPayload = buildOllamaPayload({
      modelStep: "supervisor.decision",
      format: decisionSchema,
      modelPolicy: buildPolicy("ollama"),
    });
    const openAIDiagnostics: unknown[] = [];
    const openAIPayload = buildOpenAIResponsesPayload(
      {
        modelStep: "supervisor.decision",
        messages: [
          {
            role: "system",
            content: "Runtime-owned Supervisor instructions.",
          },
          {
            role: "user",
            content: "Choose the next action.",
          },
        ],
        format: decisionSchema,
        modelPolicy: buildPolicy("openai"),
      },
      {
        onFormatProjection: (diagnostics) => {
          openAIDiagnostics.push(...diagnostics);
        },
      },
    );

    expect(ollamaPayload.format).toEqual(decisionSchema.schema);
    expect(openAIPayload.text).toEqual({
      format: { type: "json_object" },
    });
    expect(openAIPayload.input).toEqual([
      {
        role: "system",
        content: expect.stringContaining(
          '"kind":{"type":"string","enum":["tool"]}',
        ),
      },
      {
        role: "system",
        content: "Runtime-owned Supervisor instructions.",
      },
      {
        role: "user",
        content: "Choose the next action.",
      },
    ]);
    expect(openAIDiagnostics).toEqual([
      expect.objectContaining({
        action: "schema_instruction_injected",
        reason: "openai_root_union_unsupported",
      }),
    ]);
  });

  test("injects selected model calibration instructions into Ollama messages", () => {
    const payload = buildOllamaPayload({
      agentMode: "reasoning",
      modelStep: "supervisor.decision",
      modelPreference: {
        profileId: "preferred",
        scope: "all",
      },
      messages: [
        {
          role: "user",
          content: "Run the next step.",
        },
      ],
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          preferred: {
            provider: "ollama",
            model: "preferred-model",
            contextWindowTokens: 32_768,
            calibration: {
              "supervisor.decision": {
                instructions: [
                  "Return only valid decision JSON.",
                  "Keep payload content out of control JSON.",
                ],
              },
            },
          },
        },
        defaults: {
          steps: {
            "supervisor.decision": "supervisor.decision",
          },
        },
      },
    });

    expect(payload.messages).toEqual([
      {
        role: "system",
        content:
          "Return only valid decision JSON.\nKeep payload content out of control JSON.",
      },
      {
        role: "user",
        content: "Run the next step.",
      },
    ]);
  });

  test("applies selected model calibration format to Ollama raw requests", () => {
    const payload = buildOllamaRawPayload({
      agentMode: "reasoning",
      modelStep: "custom.raw",
      prompt: "Generate raw output.",
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          preferred: {
            provider: "ollama",
            model: "preferred-model",
            contextWindowTokens: 32_768,
            calibration: {
              "custom.rawSlot": {
                format: "json",
                instructions: ["Return a JSON object for this raw request."],
              },
            },
          },
        },
        defaults: {
          profileId: "preferred",
          steps: {
            "custom.raw": "custom.rawSlot",
          },
        },
      },
    });

    expect(payload).toMatchObject({
      model: "preferred-model",
      format: "json",
    });
    expect(payload.messages).toEqual([
      {
        role: "system",
        content: "Return a JSON object for this raw request.",
      },
      {
        role: "user",
        content: "Generate raw output.",
      },
    ]);
  });

  test("preserves invocation profile format when calibration omits format", () => {
    const payload = buildOllamaRawPayload({
      agentMode: "reasoning",
      modelStep: "context.compact",
      prompt: "Compact context.",
      modelPolicy: {
        providers: OLLAMA_TEST_PROVIDERS,
        profiles: {
          base: {
            provider: "ollama",
            model: "base-model",
            contextWindowTokens: 32_768,
            calibration: {
              compactSlot: {
                generation: {
                  temperature: 0.05,
                },
              },
            },
          },
        },
        invocationProfiles: {
          jsonDefault: {
            profileId: "base",
            format: "json",
          },
        },
        defaults: {
          profileId: "jsonDefault",
          steps: {
            "context.compact": "compactSlot",
          },
        },
      },
    });

    expect(payload).toMatchObject({
      model: "base-model",
      format: "json",
      options: {
        temperature: 0.05,
      },
    });
  });

  test("injects selected model calibration instructions into OpenAI input", () => {
    const payload = buildOpenAIResponsesPayload({
      agentMode: "reasoning",
      modelStep: "planner.decision",
      text: "Plan the work.",
      modelPolicy: {
        providers: OPENAI_TEST_PROVIDERS,
        profiles: {
          preferred: {
            provider: "openai",
            model: "gpt-test",
            contextWindowTokens: 32_768,
            supportsThinking: true,
            calibration: {
              "planner.decision": {
                instructions: ["Produce compact planning JSON."],
              },
            },
          },
        },
        defaults: {
          profileId: "preferred",
          steps: {
            "planner.decision": "planner.decision",
          },
        },
      },
    });

    expect(payload.input).toEqual([
      {
        role: "system",
        content: "Produce compact planning JSON.",
      },
      {
        role: "user",
        content: "Plan the work.",
      },
    ]);
  });

  test("forwards OpenAI stream errors as errors, not content", async () => {
    const chunks: string[] = [];

    await forwardOpenAIResponsesStream(
      createSseStream([
        'data: {"type":"error","error":{"message":"quota exceeded"}}\n\n',
      ]),
      serializedEventSink(chunks),
    );

    expect(chunks).toEqual([
      `${JSON.stringify({ type: "error", error: "quota exceeded" })}\n`,
    ]);
  });

  test("forwards max-output OpenAI responses as terminal incomplete output", async () => {
    const chunks: string[] = [];

    await forwardOpenAIResponsesStream(
      createSseStream([
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":120,"output_tokens":4096,"total_tokens":4216}}}\n\n',
        "data: [DONE]\n\n",
      ]),
      serializedEventSink(chunks),
    );

    expect(chunks).toEqual([
      `${JSON.stringify({ type: "content", text: "partial" })}\n`,
      `${JSON.stringify({
        type: "done",
        done: true,
        usage: {
          inputTokens: 120,
          outputTokens: 4096,
          totalTokens: 4216,
        },
        doneReason: "max_output_tokens",
      })}\n`,
    ]);
  });

  test("keeps non-repairable incomplete OpenAI responses as errors", async () => {
    const chunks: string[] = [];

    await forwardOpenAIResponsesStream(
      createSseStream([
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n',
      ]),
      serializedEventSink(chunks),
    );

    expect(chunks).toEqual([
      `${JSON.stringify({ type: "content", text: "partial" })}\n`,
      `${JSON.stringify({
        type: "error",
        error: "openai response incomplete: content_filter",
      })}\n`,
    ]);
  });

  test("forwards provider token usage from OpenAI completion events", async () => {
    const chunks: string[] = [];

    await forwardOpenAIResponsesStream(
      createSseStream([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":80},"output_tokens":30,"output_tokens_details":{"reasoning_tokens":10},"total_tokens":150}}}\n\n',
      ]),
      serializedEventSink(chunks),
    );

    expect(chunks).toEqual([
      `${JSON.stringify({
        type: "done",
        done: true,
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          cachedInputTokens: 80,
          reasoningTokens: 10,
        },
        doneReason: null,
      })}\n`,
    ]);
  });

  test("leaves multiple unstructured OpenAI message outputs unchanged", async () => {
    const chunks: string[] = [];

    await forwardOpenAIResponsesStream(
      createSseStream(
        createOpenAIMessageOutputEvents([
          { itemId: "message-1", outputIndex: 1, text: "first" },
          { itemId: "message-2", outputIndex: 3, text: "second" },
        ]),
      ),
      serializedEventSink(chunks),
    );

    expect(chunks).toEqual([
      `${JSON.stringify({ type: "content", text: "first" })}\n`,
      `${JSON.stringify({ type: "content", text: "second" })}\n`,
      `${JSON.stringify({ type: "done", done: true, doneReason: null })}\n`,
    ]);
  });

  test("keeps the first structured OpenAI message and ignores identical additional messages", async () => {
    const decision = '{"decision":{"action":"return_result"}}';
    const chunks: string[] = [];
    const diagnostics: unknown[] = [];

    await forwardOpenAIResponsesStream(
      createSseStream(
        createOpenAIMessageOutputEvents([
          { itemId: "message-1", outputIndex: 1, text: decision },
          { itemId: "message-2", outputIndex: 3, text: decision },
        ]),
      ),
      serializedEventSink(chunks),
      {
        structuredOutput: true,
        onMessageOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );

    expect(chunks).toEqual([
      `${JSON.stringify({ type: "content", text: decision })}\n`,
      `${JSON.stringify({ type: "done", done: true, doneReason: null })}\n`,
    ]);
    expect(diagnostics).toEqual([
      {
        outcome: "additional_message_outputs_ignored",
        outputCount: 2,
        selectedOutput: {
          itemId: "message-1",
          outputIndex: 1,
          arrivalOrder: 1,
          textByteCount: Buffer.byteLength(decision, "utf8"),
        },
        ignoredOutputCount: 1,
        sampledIgnoredOutputs: [
          {
            itemId: "message-2",
            outputIndex: 3,
            arrivalOrder: 2,
            textByteCount: Buffer.byteLength(decision, "utf8"),
          },
        ],
        omittedIgnoredOutputCount: 0,
      },
    ]);

    await expect(
      collectOpenAIResponsesStream(
        createSseStream(
          createOpenAIMessageOutputEvents([
            { itemId: "message-1", outputIndex: 1, text: decision },
            { itemId: "message-2", outputIndex: 3, text: decision },
          ]),
        ),
        { structuredOutput: true },
      ),
    ).resolves.toEqual({ text: decision, thinking: "" });
  });

  test("keeps the first structured OpenAI message and ignores differing additional messages", async () => {
    const selectedDecision = '{"decision":{"action":"return_result"}}';
    const ignoredDecision = '{"decision":{"action":"return_failure"}}';
    const chunks: string[] = [];
    const diagnostics: unknown[] = [];
    const events = createOpenAIMessageOutputEvents([
      {
        itemId: "message-1",
        outputIndex: 1,
        text: selectedDecision,
      },
      {
        itemId: "message-2",
        outputIndex: 3,
        text: ignoredDecision,
      },
    ]);

    await forwardOpenAIResponsesStream(
      createSseStream(events),
      serializedEventSink(chunks),
      {
        structuredOutput: true,
        onMessageOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );

    expect(chunks).toEqual([
      `${JSON.stringify({
        type: "content",
        text: selectedDecision,
      })}\n`,
      `${JSON.stringify({ type: "done", done: true, doneReason: null })}\n`,
    ]);
    expect(diagnostics).toEqual([
      {
        outcome: "additional_message_outputs_ignored",
        outputCount: 2,
        selectedOutput: {
          itemId: "message-1",
          outputIndex: 1,
          arrivalOrder: 1,
          textByteCount: Buffer.byteLength(selectedDecision, "utf8"),
        },
        ignoredOutputCount: 1,
        sampledIgnoredOutputs: [
          {
            itemId: "message-2",
            outputIndex: 3,
            arrivalOrder: 2,
            textByteCount: Buffer.byteLength(ignoredDecision, "utf8"),
          },
        ],
        omittedIgnoredOutputCount: 0,
      },
    ]);
    await expect(
      collectOpenAIResponsesStream(createSseStream(events), {
        structuredOutput: true,
      }),
    ).resolves.toEqual({ text: selectedDecision, thinking: "" });
  });

  test("keeps a batch decision inside one OpenAI message opaque", async () => {
    const decision = JSON.stringify({
      decision: {
        action: "invoke_capabilities",
        invocations: [
          { capabilityId: "observe-a" },
          { capabilityId: "observe-b" },
        ],
      },
    });

    await expect(
      collectOpenAIResponsesStream(
        createSseStream(
          createOpenAIMessageOutputEvents([
            { itemId: "message-1", outputIndex: 1, text: decision },
          ]),
        ),
        { structuredOutput: true },
      ),
    ).resolves.toEqual({ text: decision, thinking: "" });
  });

  test("collects provider token usage with raw OpenAI output", async () => {
    const collected = await collectOpenAIResponsesStream(
      createSseStream([
        'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":45,"input_tokens_details":{"cached_tokens":20},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":52}}}\n\n',
      ]),
    );

    expect(collected).toEqual({
      text: "ok",
      thinking: "",
      usage: {
        inputTokens: 45,
        outputTokens: 7,
        totalTokens: 52,
        cachedInputTokens: 20,
        reasoningTokens: 2,
      },
    });
  });

  test("collects the max-output completion reason with partial raw output", async () => {
    const collected = await collectOpenAIResponsesStream(
      createSseStream([
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
      ]),
    );

    expect(collected).toEqual({
      text: "partial",
      thinking: "",
      doneReason: "max_output_tokens",
    });
  });

  test("collecting OpenAI stream errors fails instead of returning error text", async () => {
    await expect(
      collectOpenAIResponsesStream(
        createSseStream([
          'data: {"type":"error","error":{"message":"quota exceeded"}}\n\n',
        ]),
      ),
    ).rejects.toThrow("openai_stream_error: quota exceeded");
  });

  test("collecting an incomplete OpenAI response rejects its partial output", async () => {
    await expect(
      collectOpenAIResponsesStream(
        createSseStream([
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    ).rejects.toThrow(
      "openai_stream_error: openai response incomplete: content_filter",
    );
  });
});
