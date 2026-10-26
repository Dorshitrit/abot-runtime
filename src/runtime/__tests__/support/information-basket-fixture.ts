import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { ModelGatewayEmbeddingParams, ModelGatewayEmbeddingResult } from "../../../model-gateway/types.js";
import type { BasketSource, InformationBasketService } from "../../information-basket/contracts.js";
import { createInformationBasketService } from "../../information-basket/service.js";
import type { RuntimeConfig } from "../../ports.js";
import { loadPublicRuntimeConfig } from "../public-runtime-config-fixture.js";

export function fixtureEmbedding(input: ModelGatewayEmbeddingParams): ModelGatewayEmbeddingResult {
  return {
    profileId: input.profileId, provider: "ollama", model: "fixture", modelFingerprint: "fixture-v1",
    dimensions: 2, vectors: input.texts.map(text => text.includes("orange") ? [0, 5] : [4, 0]),
  };
}
export async function createBasketFixture(
  embed = vi.fn(async (input: ModelGatewayEmbeddingParams) => fixtureEmbedding(input)),
) {
  const base = join(process.cwd(), ".codex", "artifacts", "information-basket-service", "tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "case-"));
  const files = join(root, "files");
  await mkdir(files);
  const original = loadPublicRuntimeConfig([]);
  const config: RuntimeConfig = {
    ...original, runtimeId: "basket-fixture",
    paths: { ...original.paths, runtimeDir: join(root, "runtime"), agentWorkDir: files, workspaceDir: files },
    models: {
      ...original.models,
      providers: { ...original.models?.providers, basketFixture: { type: "ollama", baseUrl: "http://invalid.test" } },
      embeddingProfiles: {
        fixture: { label: "Fixture vectors", provider: "basketFixture", model: "fixture" },
        alternate: { label: "Alternate vectors", provider: "basketFixture", model: "other-fixture" },
      },
    },
  };
  const service = createInformationBasketService({ config, models: { embed } });
  await service.start();
  const source = async (name: string, body: string | Uint8Array) => {
    const path = join(files, name);
    await writeFile(path, body);
    return path;
  };
  return { root, config, files, service, embed, source };
}
export async function configureBasket(service: InformationBasketService, profile = "fixture") {
  const current = await service.list();
  return service.updateSettings({ expectedRevision: current.settings.revision, enabled: true, embeddingProfileId: profile });
}
export async function waitForBasketSource(service: InformationBasketService, status: BasketSource["status"] = "ready"): Promise<BasketSource> {
  let result: BasketSource | undefined;
  await vi.waitFor(async () => {
    result = (await service.list()).sources.find(source => source.status === status);
    expect(result).toBeDefined();
  }, { timeout: 8_000, interval: 15 });
  return result!;
}
