import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createModelProviderAdapterRegistry,
  type ModelProviderAdapter,
} from "../../model-gateway/index.js";
import { createLocalLongTermMemoryOnboardingService } from "../adapters/long-term-memory/onboarding-service.js";

describe("local long-term memory onboarding adapter", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("uses the injected custom provider registry for discovery and probing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "abot-memory-onboarding-"));
    directories.push(rootDir);
    await writeFile(
      join(rootDir, "runtime.config.json"),
      JSON.stringify({
        models: {
          providers: {
            fixture: { type: "fixture-provider" },
          },
          profiles: {
            chat: {
              provider: "fixture",
              model: "fixture-chat",
              contextWindowTokens: 32_768,
            },
          },
        },
        requestRunner: { configRef: "./request-runner.config.json" },
      }),
      "utf8",
    );
    const embed = vi.fn<NonNullable<ModelProviderAdapter["embed"]>>(
      async ({ texts }) => ({
        kind: "embedded",
        modelFingerprint: "sha256:fixture",
        vectors: texts.map(() => [0.25, 0.75]),
      }),
    );
    const listEmbeddingModels = vi.fn<
      NonNullable<ModelProviderAdapter["listEmbeddingModels"]>
    >(async () => ({ kind: "listed", models: ["fixture-embedding"] }));
    const providerAdapters = createModelProviderAdapterRegistry([
      {
        type: "fixture-provider",
        supportsImageInput: false,
        embed,
        listEmbeddingModels,
        invoke: async () => ({ kind: "raw", body: {} }),
      },
    ]);
    const service = createLocalLongTermMemoryOnboardingService({
      rootDir,
      providerAdapters,
    });

    await expect(service.discover({ providerId: "fixture" })).resolves.toEqual({
      supported: true,
      models: ["fixture-embedding"],
    });
    await expect(
      service.enable({
        providerId: "fixture",
        model: "fixture-embedding",
      }),
    ).resolves.toMatchObject({
      restartRequired: true,
      probe: { modelFingerprint: "sha256:fixture", dimensions: 2 },
    });

    expect(listEmbeddingModels).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledOnce();
  });
});
