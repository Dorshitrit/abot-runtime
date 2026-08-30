import { describe, expect, test } from "vitest";

import { buildLongTermMemoryConfig } from "../config/long-term-memory.js";
import type { RuntimeConfigFile } from "../config/types.js";
import { validateRuntimeConfigFile } from "../config/validation.js";

const BASE_CONFIG = {
  models: {
    providers: { local: { type: "ollama" } },
    profiles: {
      chat: {
        provider: "local",
        model: "chat-model",
        contextWindowTokens: 32_768,
      },
    },
  },
  requestRunner: { configRef: "./request-runner.config.json" },
} satisfies RuntimeConfigFile;

describe("long-term memory runtime config", () => {
  test("defaults to disabled without guessing an embedding model", () => {
    expect(buildLongTermMemoryConfig(BASE_CONFIG)).toEqual({
      enabled: false,
      emitClientEvents: false,
    });
  });

  test("requires an existing embedding profile before enabling", () => {
    expect(() =>
      validateRuntimeConfigFile(
        {
          ...BASE_CONFIG,
          longTermMemory: {
            enabled: true,
            embeddingProfileId: "missing",
          },
        },
        "/fixture/runtime.config.json",
      ),
    ).toThrow(
      "longTermMemory.embeddingProfileId references unknown embedding profile missing",
    );
  });

  test("keeps embedding profiles separate from generation configuration", () => {
    expect(() =>
      validateRuntimeConfigFile(
        {
          ...BASE_CONFIG,
          models: {
            ...BASE_CONFIG.models,
            embeddingProfiles: {
              memory: {
                provider: "local",
                model: "embedding-model",
                generation: { temperature: 0 },
              },
            },
          },
        },
        "/fixture/runtime.config.json",
      ),
    ).toThrow(
      "models.embeddingProfiles.memory.generation is not supported for embeddings",
    );
  });

  test("accepts a provider-bound profile and explicit event preference", () => {
    const config: RuntimeConfigFile = {
      ...BASE_CONFIG,
      models: {
        ...BASE_CONFIG.models,
        embeddingProfiles: {
          memory: { provider: "local", model: "embedding-model" },
        },
      },
      longTermMemory: {
        enabled: true,
        emitClientEvents: true,
        embeddingProfileId: "memory",
      },
    };

    expect(() =>
      validateRuntimeConfigFile(config, "/fixture/runtime.config.json"),
    ).not.toThrow();
    expect(buildLongTermMemoryConfig(config)).toEqual({
      enabled: true,
      emitClientEvents: true,
      embeddingProfileId: "memory",
    });
  });
});
