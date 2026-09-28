import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseRuntimeSetupInput } from "../../web-ui/local-runtime/runtime-setup-input.js";
import { parseModelSetupInput } from "../../web-ui/local-runtime/model-setup-input.js";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import {
  buildModelConfig,
  readDefaultContextWindowTokens,
} from "../../../scripts/runtime-setup-files.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";
let fixture: ModelSetupFixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

test.each([
  null,
  "65536",
  0,
  -1,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
  Infinity,
  {},
])(
  "rejects malformed context window %s before either setup flow writes",
  (value) => {
    expect(() =>
      parseRuntimeSetupInput({
        provider: "ollama",
        model: "fixture",
        contextWindowTokens: value,
      }),
    ).toThrow("positive whole number");
    expect(() =>
      parseModelSetupInput({
        profileId: "fixture",
        providerId: "ollama",
        model: "fixture",
        contextWindowTokens: value,
      }),
    ).toThrow("positive whole number");
  },
);

test("preserves the template default on omission and applies only an explicit context override", async () => {
  const template = JSON.parse(
    await readFile("examples/models/default.config.json", "utf8"),
  );
  expect(await readDefaultContextWindowTokens()).toBe(
    template.contextWindowTokens,
  );
  expect(
    buildModelConfig(template, "openai", "fixture").contextWindowTokens,
  ).toBe(template.contextWindowTokens);
  expect(buildModelConfig(template, "openai", "fixture", 65536)).toMatchObject({
    contextWindowTokens: 65536,
    context: template.context,
    execution: { policy: "execution-agent-v1" },
  });
});

test("saves a model's declared context and publishes canonical defaults and existing setup context", async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-review-fixes-20260908/context",
  );
  await fixture.service.add({
    profileId: "larger",
    providerId: "ollama",
    model: "fixture-larger",
    contextWindowTokens: 65536,
  });
  const declaration = (await fixture.readConfig()).models.profiles.larger;
  expect(declaration).toEqual({ configRef: "./models/larger.config.json" });
  const addedProfile = await fixture.readModelProfile("larger");
  expect(addedProfile.contextWindowTokens).toBe(65536);
  expect((await fixture.service.catalog()).defaultContextWindowTokens).toBe(
    await readDefaultContextWindowTokens(),
  );
  const setup = new RuntimeSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture!.configPath,
    activate: async () => ({ status: "ready" }),
  });
  const modelPath = join(fixture.rootDir, "local/models/default.config.json");
  const template = JSON.parse(await readFile(modelPath, "utf8"));
  const status = await setup.status();
  expect(status.defaultContextWindowTokens).toBe(
    await readDefaultContextWindowTokens(),
  );
  expect(status.existingModel?.contextWindowTokens).toBe(
    template.contextWindowTokens,
  );
  await expect(
    setup.save({
      provider: "ollama",
      model: "fixture-chat",
      contextWindowTokens: 131072,
      deferActivation: true,
    }),
  ).rejects.toMatchObject({
    code: "setup_configuration_exists",
    statusCode: 409,
  });
  expect(
    JSON.parse(await readFile(modelPath, "utf8")).contextWindowTokens,
  ).toBe(template.contextWindowTokens);
});

test("initial onboarding writes the user context window into the referenced default model", async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-review-fixes-20260908/context",
  );
  const rootDir = join(fixture.rootDir, "new-user");
  let configPath: string | undefined;
  const setup = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate: async () => ({ status: "ready" }),
  });
  const saved = await setup.save({
    provider: "ollama",
    model: "fixture-model",
    contextWindowTokens: 131072,
    deferActivation: true,
  });
  expect(saved.setup.existingModel?.contextWindowTokens).toBe(131072);
  expect(
    JSON.parse(
      await readFile(join(rootDir, "local/models/default.config.json"), "utf8"),
    ).contextWindowTokens,
  ).toBe(131072);
});
