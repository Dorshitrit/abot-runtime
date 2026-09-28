import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr86-review-paths-20260923/profile-id-boundaries",
  );
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("model addition input and persistence boundaries", () => {
  test.each([
    { profileId: "../escape", model: "fixture", providerId: "ollama" },
    { profileId: "constructor", model: "fixture", providerId: "ollama" },
    { profileId: "x".repeat(129), model: "fixture", providerId: "ollama" },
    { profileId: "valid", model: "bad model", providerId: "ollama" },
    {
      profileId: "valid",
      model: "fixture",
      providerId: "ollama",
      defaults: {},
    },
    {
      profileId: "valid",
      model: "fixture",
      providerId: "ollama",
      newProvider: { id: "new", type: "ollama" },
    },
    {
      profileId: "valid",
      model: "fixture",
      newProvider: { id: "__proto__", type: "ollama" },
    },
    {
      profileId: "valid",
      model: "fixture",
      newProvider: { id: "new", type: "unknown" },
    },
    {
      profileId: "valid",
      model: "fixture",
      newProvider: { id: "new", type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
      apiKey: "fixture-key",
    },
    {
      profileId: "valid",
      model: "fixture",
      newProvider: { id: "new", type: "openai" },
      apiKey: 'bad"key',
    },
    {
      profileId: "valid",
      model: "fixture",
      newProvider: {
        id: "new",
        type: "ollama",
        baseUrl: "http://user:secret@localhost",
      },
    },
    {
      profileId: "valid",
      model: "fixture",
      newProvider: {
        id: "new",
        type: "ollama",
        baseUrl: "http://localhost/path",
      },
    },
    {
      profileId: "valid",
      model: "fixture",
      providerId: "ollama",
      apiKey: "fixture-key",
    },
    { profileId: "valid", model: "fixture", providerId: "missing" },
  ])(
    "rejects malformed or unsupported additions without changing config or credentials: %j",
    async (input) => {
      const config = await readFile(fixture.configPath, "utf8");
      const env = await fixture.readEnv();
      await expect(fixture.service.add(input)).rejects.toThrow();
      expect(await readFile(fixture.configPath, "utf8")).toBe(config);
      expect(await fixture.readEnv()).toBe(env);
    },
  );

  test.each(
    [
      ...["CON", "PRN", "AUX", "NUL"],
      ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
    ]
      .flatMap((id) => [id, `${id.toLowerCase()}.profile`])
      .concat(["cOn", "aUx.extra.part"]),
  )(
    "rejects Windows device profile ID %s before changing files or credentials",
    async (profileId) => {
      const config = await readFile(fixture.configPath, "utf8");
      const env = await fixture.readEnv();
      const modelsDirectory = join(dirname(fixture.configPath), "models");
      const modelFiles = await readdir(modelsDirectory);
      await expect(
        fixture.service.add({
          profileId,
          model: "fixture",
          newProvider: { id: "new-cloud", type: "openai" },
          apiKey: "fixture-never-save",
        }),
      ).rejects.toMatchObject({ code: "invalid_profile_id", statusCode: 400 });
      expect(await readFile(fixture.configPath, "utf8")).toBe(config);
      expect(await fixture.readEnv()).toBe(env);
      expect(await readdir(modelsDirectory)).toEqual(modelFiles);
    },
  );

  test.each([
    "console",
    "auxiliary",
    "COM0",
    "COM10",
    "LPT0",
    "LPT10",
    "COM1x",
    "CON-model",
    "NUL_model",
    "model.CON",
  ])("persists the nearby portable profile ID %s", async (profileId) => {
    await expect(
      fixture.service.add({
        profileId,
        model: "fixture",
        providerId: "ollama",
      }),
    ).resolves.toMatchObject({ model: { profileId } });
    expect((await fixture.readConfig()).models.profiles[profileId]).toEqual({
      configRef: `./models/${profileId}.config.json`,
    });
    expect(await fixture.readModelProfile(profileId)).toMatchObject({
      provider: "ollama",
      model: "fixture",
    });
  });

  test.each(["CON", "PRN", "aux", "NUL", "COM1", "LPT9"])(
    "preserves Windows device name %s as a provider ID",
    async (providerId) => {
      await expect(
        fixture.service.add({
          profileId: "portable-profile",
          model: "fixture",
          newProvider: { id: providerId, type: "ollama" },
        }),
      ).resolves.toMatchObject({ model: { providerId } });
      expect(await fixture.readModelProfile("portable-profile")).toMatchObject({
        provider: providerId,
      });
    },
  );

  test("rejects registered profile and new-provider collisions before credentials", async () => {
    const env = await fixture.readEnv();
    await expect(
      fixture.service.add({
        profileId: "default",
        model: "fixture",
        newProvider: { id: "new-cloud", type: "openai" },
        apiKey: "fixture-never-save",
      }),
    ).rejects.toMatchObject({ code: "model_profile_exists", statusCode: 409 });
    await expect(
      fixture.service.add({
        profileId: "new-model",
        model: "fixture",
        newProvider: { id: "ollama", type: "openai" },
        apiKey: "fixture-never-save",
      }),
    ).rejects.toMatchObject({ code: "model_provider_exists", statusCode: 409 });
    expect(await fixture.readEnv()).toBe(env);
  });

  test("offers an unregistered ID for exact recovery but preserves a mismatched file", async () => {
    const content = await readFile(
      join(fixture.rootDir, "local/models/default.config.json"),
      "utf8",
    );
    const path = join(fixture.rootDir, "local/models/orphan.config.json");
    await writeFile(path, content);
    expect((await fixture.service.catalog()).profileIds).not.toContain(
      "orphan",
    );
    await expect(
      fixture.service.add({
        profileId: "orphan",
        model: "fixture",
        providerId: "ollama",
      }),
    ).rejects.toMatchObject({ code: "model_profile_exists" });
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("does not reuse another connection's global key for a new OpenAI provider", async () => {
    await writeFile(
      fixture.envPath,
      `${await fixture.readEnv()}OPENAI_API_KEY="fixture-unrelated-key"\n`,
    );
    const config = await fixture.readConfig();
    const env = await fixture.readEnv();
    await expect(
      fixture.service.add({
        profileId: "new-model",
        model: "fixture",
        newProvider: { id: "another-cloud", type: "openai" },
      }),
    ).rejects.toMatchObject({ code: "model_credential_required" });
    expect(await fixture.readConfig()).toEqual(config);
    expect(await fixture.readEnv()).toBe(env);
  });

  test("rejects a credential-file symlink before saving a model or changing its target", async () => {
    const config = await fixture.readConfig();
    const target = join(fixture.rootDir, "preserved-env");
    await writeFile(target, "KEEP=unchanged\n");
    await rm(fixture.envPath);
    await symlink(target, fixture.envPath);
    await expect(
      fixture.service.add({
        profileId: "new-model",
        model: "fixture",
        newProvider: { id: "new-cloud", type: "openai" },
        apiKey: "fixture-unsafe",
      }),
    ).rejects.toThrow();
    expect(await fixture.readConfig()).toEqual(config);
    expect(await readFile(target, "utf8")).toBe("KEEP=unchanged\n");
  });

  test("rejects a config symlink outside the canonical workspace before any mutation", async () => {
    const outside = await mkdtemp(join(dirname(fixture.rootDir), "outside-"));
    try {
      const target = join(outside, "runtime.config.json");
      const raw = await readFile(fixture.configPath, "utf8");
      await writeFile(target, raw);
      const alias = join(fixture.rootDir, "outside-alias.json");
      await symlink(target, alias);
      const service = new ModelSetupService({
        rootDir: fixture.rootDir,
        getConfigPath: () => alias,
      });
      await expect(
        service.add({
          profileId: "new",
          model: "fixture",
          providerId: "ollama",
        }),
      ).rejects.toMatchObject({ code: "model_config_outside_workspace" });
      expect(await readFile(target, "utf8")).toBe(raw);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
