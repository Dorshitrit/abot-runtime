import { describe, expect, test } from "vitest";

import { RUNTIME_CONFIG_SCHEMA_FIELDS } from "../config/fields.js";
import { RUNTIME_CONFIG_JSON_SCHEMA } from "../config/schema.js";
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
      maxRecallCallsPerRequest: 5,
    });
  });

  test.each([2, 7, Number.MAX_SAFE_INTEGER])(
    "accepts an explicit recall limit of %s",
    (maxRecallCallsPerRequest) => {
      const config = {
        ...BASE_CONFIG,
        longTermMemory: { maxRecallCallsPerRequest },
      };
      expect(() =>
        validateRuntimeConfigFile(config, "/fixture/runtime.config.json"),
      ).not.toThrow();
      expect(buildLongTermMemoryConfig(config)).toEqual({
        enabled: false,
        emitClientEvents: false,
        maxRecallCallsPerRequest,
      });
    },
  );

  test.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "5",
    true,
    null,
  ])("rejects invalid recall limit %s", (maxRecallCallsPerRequest) => {
    expect(() =>
      validateRuntimeConfigFile(
        { ...BASE_CONFIG, longTermMemory: { maxRecallCallsPerRequest } },
        "/fixture/runtime.config.json",
      ),
    ).toThrow(
      "longTermMemory.maxRecallCallsPerRequest must be a positive safe integer",
    );
  });

  test("publishes the configurable recall bound in schema and discovery", () => {
    expect(RUNTIME_CONFIG_JSON_SCHEMA).toHaveProperty(
      "properties.longTermMemory.properties.maxRecallCallsPerRequest",
      expect.objectContaining({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        default: 5,
      }),
    );
    expect(RUNTIME_CONFIG_SCHEMA_FIELDS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "longTermMemory.maxRecallCallsPerRequest",
          defaultValue: "5",
        }),
      ]),
    );
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
      maxRecallCallsPerRequest: 5,
      embeddingProfileId: "memory",
    });
  });
});
