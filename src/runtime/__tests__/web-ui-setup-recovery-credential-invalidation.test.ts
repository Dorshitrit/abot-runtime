import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let service: RuntimeSetupService;
const cloud = {
  provider: "openai",
  model: "cloud-chat",
  apiKey: "fixture-original-key",
  deferActivation: true,
};
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-apply-recovery-20260908/credential-invalidation",
  );
  service = new RuntimeSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
    activate: async () => ({ status: "ready" }),
  });
});
afterEach(async () => fixture.cleanup());

test.each([
  [true, true, "openai", true],
  [true, false, "openai", false],
  [false, true, "openai", false],
  [true, true, "separate", false],
] as const)(
  "recovery credential rotation invalidates only its enabled embedding (%s,%s,%s)",
  async (enabled, rotate, embeddingProvider, invalidated) => {
    const draft = JSON.parse(
      await readFile(fixture.configPath + ".web-setup.json", "utf8"),
    );
    await service.save({ ...cloud, connectionRevision: draft.revision });
    const config = await fixture.readConfig();
    config.models.profiles = {};
    config.models.providers.separate = {
      type: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    };
    config.models.embeddingProfiles = {
      selected: {
        provider: " " + embeddingProvider + " ",
        model: "embedding-fixture",
      },
    };
    config.longTermMemory = { enabled, embeddingProfileId: " selected " };
    await fixture.writeConfig(config);
    const key = rotate ? "fixture-rotated-key" : cloud.apiKey;
    const saved = await service.save({ ...cloud, apiKey: key });
    expect(saved.embeddingInvalidated).toBe(invalidated);
    const after = await fixture.readConfig();
    expect(after.models.providers.openai).toEqual(
      config.models.providers.openai,
    );
    expect(after.models.embeddingProfiles).toEqual(
      config.models.embeddingProfiles,
    );
    expect(after.longTermMemory).toEqual({
      ...config.longTermMemory,
      enabled: enabled && !invalidated,
    });
    expect(await fixture.readEnv()).toContain(key);
  },
);
