import { isDeepStrictEqual } from "node:util";
import { describe, expect, test, vi } from "vitest";
import type { RuntimeConfigFile } from "../config/types.js";
import { createLongTermMemoryOnboardingService } from "../long-term-memory/onboarding/service.js";

function harness() {
  let config: RuntimeConfigFile = {
    models: {
      providers: {
        cloud: { type: "openai", apiKeyEnv: "PRIVATE_KEY" },
        ollama: { type: "ollama", baseUrl: "http://ollama.test" },
        cpp: { type: "llamacpp", baseUrl: "http://llamacpp.test" },
      },
      profiles: { chat: { provider: "cloud", model: "chat", contextWindowTokens: 32768 } },
      embeddingProfiles: {
        active: { provider: "cloud", model: "existing", label: "Existing", options: { dimensions: 512 } },
      },
    },
    longTermMemory: { enabled: true, embeddingProfileId: "active", maxRecallCallsPerRequest: 7 },
    plugins: { allow: ["memory"] },
    requestRunner: { configRef: "./request-runner.config.json" },
  };
  const probe = vi.fn(async () => ({ modelFingerprint: "fixture", dimensions: 512 }));
  const write = vi.fn(async (next: RuntimeConfigFile, expected?: RuntimeConfigFile) => {
    if (!isDeepStrictEqual(config, expected)) throw new Error("long_term_memory_config_changed");
    config = structuredClone(next);
    return { configPath: "/fixture/config.json" };
  });
  const service = createLongTermMemoryOnboardingService({
    repository: { read: async () => ({ config: structuredClone(config), path: "/fixture/config.json" }), write },
    probe, discover: vi.fn(),
  });
  return { service, probe, write, current: () => config, replace: (next: RuntimeConfigFile) => { config = next; } };
}

describe("saved embedding profiles", () => {
  test("removes only the chosen inactive profile without changing credentials, bindings or sibling choices", async () => {
    const h = harness();
    const input = { label: "Qwen", providerId: "cpp", model: "qwen" };
    const first = await h.service.saveProfile(input);
    const sibling = await h.service.saveProfile(input);
    const before = structuredClone(h.current());
    const result = await h.service.removeProfile({ profileId: first.profileId });
    const expected = structuredClone(before);
    delete (expected.models as any).embeddingProfiles[first.profileId];
    expect(h.current()).toEqual(expected);
    expect(result).toMatchObject({ removed: true, profileId: first.profileId, status: { profileId: "active" } });
    expect(result.status.embeddingProfiles).toContainEqual(expect.objectContaining({ id: sibling.profileId }));
    expect(result).not.toHaveProperty("restartRequired");
    expect(h.probe).not.toHaveBeenCalled();
  });

  test.each([true, false])("protects configured memory profile even when enabled=%s", async (enabled) => {
    const h = harness();
    h.replace({ ...h.current(), longTermMemory: { enabled, embeddingProfileId: " active " } });
    await expect(h.service.removeProfile({ profileId: "active" })).rejects.toMatchObject({ statusCode: 409 });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  test("rejects missing profile, blank selection, cancellation and stale config without writing", async () => {
    const h = harness();
    await expect(h.service.removeProfile({ profileId: "missing" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(h.service.removeProfile({ profileId: " " })).rejects.toThrow("long_term_memory_profileId_required");
    expect(h.write).not.toHaveBeenCalled();
    const saved = await h.service.saveProfile({ label: "Qwen", providerId: "cpp", model: "qwen" });
    h.write.mockClear();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(h.service.removeProfile({ profileId: saved.profileId, abortSignal: abort.signal })).rejects.toThrow("cancelled");
    expect(h.write).not.toHaveBeenCalled();
    h.write.mockImplementationOnce(async (_next, expected) => {
      h.replace({ ...h.current(), longTermMemory: { enabled: true, embeddingProfileId: saved.profileId } });
      if (!isDeepStrictEqual(h.current(), expected)) throw new Error("long_term_memory_config_changed");
      throw new Error("fixture expected a concurrent change");
    });
    await expect(h.service.removeProfile({ profileId: saved.profileId })).rejects.toThrow("long_term_memory_config_changed");
    expect((await h.service.status()).embeddingProfiles).toContainEqual(expect.objectContaining({ id: saved.profileId }));
    expect(h.current().longTermMemory).toMatchObject({ embeddingProfileId: saved.profileId });
    expect(h.probe).not.toHaveBeenCalled();
  });

  test("persists cloud and same-model local profiles without probing or changing active memory", async () => {
    const h = harness();
    const before = structuredClone(h.current());
    const inputs = [
      { label: "OpenAI small", providerId: "cloud", model: "text-embedding-3-small" },
      { label: "Qwen", providerId: "ollama", model: "qwen3-embedding:0.6b" },
      { label: "Qwen", providerId: "cpp", model: "qwen3-embedding:0.6b" },
    ];
    const results = [];
    for (const input of inputs) results.push(await h.service.saveProfile(input));
    expect(new Set(results.map((item) => item.profileId)).size).toBe(3);
    expect(h.current().longTermMemory).toEqual(before.longTermMemory);
    expect(h.current().plugins).toEqual(before.plugins);
    expect(h.current().requestRunner).toEqual(before.requestRunner);
    expect(h.probe).not.toHaveBeenCalled();
    const status = await h.service.status();
    expect(status.profileId).toBe("active");
    expect(status.embeddingProfiles).toHaveLength(4);
    for (const input of inputs) expect(status.embeddingProfiles).toContainEqual(expect.objectContaining(input));
    expect(JSON.stringify(status)).not.toContain("PRIVATE_KEY");
    expect(JSON.stringify(status)).not.toContain("baseUrl");
  });

  test("saving an identical name and binding cannot overwrite an existing profile", async () => {
    const h = harness();
    const input = { label: "Existing", providerId: "cloud", model: "existing" };
    const first = await h.service.saveProfile(input);
    const second = await h.service.saveProfile(input);
    expect(first.profileId).not.toBe(second.profileId);
    expect(first.profileId).not.toBe("active");
    expect((h.current().models as any).embeddingProfiles.active.options).toEqual({ dimensions: 512 });
    expect(h.current().longTermMemory).toMatchObject({ embeddingProfileId: "active" });
  });

  test("explicit activation preserves a saved profile label and target options", async () => {
    const h = harness();
    const saved = await h.service.saveProfile({ label: "Local Qwen", providerId: "cpp", model: "qwen" });
    await h.service.enable({ profileId: saved.profileId, providerId: "cpp", model: "qwen" });
    expect(h.current().longTermMemory).toMatchObject({ embeddingProfileId: saved.profileId });
    expect((h.current().models as any).embeddingProfiles[saved.profileId].label).toBe("Local Qwen");
    await h.service.enable({ profileId: "active", providerId: "cloud", model: "existing" });
    expect((h.current().models as any).embeddingProfiles.active).toEqual({
      label: "Existing", provider: "cloud", model: "existing", options: { dimensions: 512 },
    });
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  test.each([
    { providerId: "absent", model: "qwen", label: "Qwen" },
    { providerId: "cpp", model: "", label: "Qwen" },
    { providerId: "cpp", model: "qwen", label: " " },
  ])("rejects invalid profile without writing: %j", async (input) => {
    const h = harness();
    await expect(h.service.saveProfile(input)).rejects.toThrow();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  test("does not save after cancellation or overwrite a concurrent configuration change", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const input = { providerId: "cpp", model: "qwen", label: "Qwen" };
    await expect(h.service.saveProfile({ ...input, abortSignal: controller.signal })).rejects.toThrow("cancelled");
    expect(h.write).not.toHaveBeenCalled();
    h.write.mockImplementationOnce(async () => { throw new Error("long_term_memory_config_changed"); });
    await expect(h.service.saveProfile(input)).rejects.toThrow("long_term_memory_config_changed");
    expect((await h.service.status()).embeddingProfiles).toHaveLength(1);
  });
});
