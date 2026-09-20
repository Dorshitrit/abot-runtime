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
const cases = [
  {
    label: "explicit default",
    apiKeyEnv: "OPENAI_API_KEY",
    enabled: true,
    rotate: true,
    invalidated: true,
  },
  {
    label: "implicit default",
    apiKeyEnv: undefined,
    enabled: true,
    rotate: true,
    invalidated: true,
  },
  {
    label: "padded default",
    apiKeyEnv: " OPENAI_API_KEY ",
    enabled: true,
    rotate: true,
    invalidated: true,
  },
  {
    label: "separate binding",
    apiKeyEnv: "SEPARATE_EMBEDDING_KEY",
    enabled: true,
    rotate: true,
    invalidated: false,
  },
  {
    label: "disabled memory",
    apiKeyEnv: "OPENAI_API_KEY",
    enabled: false,
    rotate: true,
    invalidated: false,
  },
  {
    label: "unchanged key",
    apiKeyEnv: "OPENAI_API_KEY",
    enabled: true,
    rotate: false,
    invalidated: false,
  },
];
const scenarios = ["edit", "recovery"].flatMap((mode) =>
  cases.map((scenario) => ({ mode, ...scenario })),
);

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

test.each(scenarios)(
  "$mode invalidates shared embedding credentials for $label",
  async ({ mode, apiKeyEnv, enabled, rotate, invalidated }) => {
    const originalDraft = JSON.parse(
      await readFile(fixture.configPath + ".web-setup.json", "utf8"),
    );
    const initialized = await service.save({
      ...cloud,
      connectionRevision: originalDraft.revision,
    });
    const config = await fixture.readConfig();
    if (mode === "recovery") config.models.profiles = {};
    config.models.providers.embeddingAlias = {
      type: "openai",
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    };
    config.models.embeddingProfiles = {
      selected: { provider: " embeddingAlias ", model: "embedding-fixture" },
    };
    config.longTermMemory = {
      enabled,
      embeddingProfileId: " selected ",
      emitClientEvents: true,
    };
    await fixture.writeConfig(config);
    const key = rotate ? "fixture-rotated-key" : cloud.apiKey;
    const saved = await service.save({
      ...cloud,
      apiKey: key,
      ...(mode === "edit"
        ? { connectionRevision: initialized.setup.editableConnection!.revision }
        : {}),
    });
    const after = await fixture.readConfig();
    expect(saved.embeddingInvalidated).toBe(invalidated);
    expect(after.longTermMemory).toEqual({
      ...config.longTermMemory,
      enabled: enabled && !invalidated,
    });
    expect(after.models.providers.embeddingAlias).toEqual(
      config.models.providers.embeddingAlias,
    );
    expect(after.models.embeddingProfiles).toEqual(
      config.models.embeddingProfiles,
    );
    expect(await fixture.readEnv()).toContain(key);
  },
);
