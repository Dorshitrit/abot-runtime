import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("additive Web model setup", () => {
  test("adds an inline profile while preserving referenced files, defaults, and unrelated configuration", async () => {
    const before = await fixture.readConfig();
    const paths = [
      join(fixture.rootDir, "local/models/default.config.json"),
      join(fixture.rootDir, "local/request-runner.config.json"),
    ];
    const files = await Promise.all(
      paths.map((path) => readFile(path, "utf8")),
    );
    const result = await fixture.service.add({
      profileId: "second",
      model: "fixture-second",
      providerId: "ollama",
    });
    expect(result).toEqual({
      model: {
        profileId: "second",
        model: "fixture-second",
        providerId: "ollama",
        provider: "ollama",
      },
      restartRequired: true,
    });
    const after = await fixture.readConfig();
    expect(after).toEqual({
      ...before,
      models: {
        ...before.models,
        profiles: {
          ...before.models.profiles,
          second: expect.objectContaining({
            provider: "ollama",
            model: "fixture-second",
            context: { formatTokenAccounting: { mode: "none" } },
          }),
        },
      },
    });
    expect(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
    ).toEqual(files);
    expect((await fixture.service.catalog()).profileIds).toEqual([
      "default",
      "second",
    ]);
  });

  test.each(["openai", "ollama"])(
    "uses adapter defaults for an existing %s alias and preserves its settings",
    async (type) => {
      const config = await fixture.readConfig();
      const providerId = `work-${type}`;
      const provider = {
        type,
        baseUrl: "http://127.0.0.1:19999",
        keepAlive: "4m",
        settings: { fixture: true },
        ...(type === "openai" ? { apiKeyEnv: "MODEL_FIXTURE_KEY" } : {}),
      };
      config.models.providers[providerId] = provider;
      await fixture.writeConfig(config);
      await writeFile(
        fixture.envPath,
        `${await fixture.readEnv()}MODEL_FIXTURE_KEY="fixture-custom-key"\n`,
      );
      const catalog = await fixture.service.catalog();
      expect(
        catalog.providers.find((entry) => entry.id === providerId),
      ).toMatchObject({
        requiresApiKey: type === "openai",
        credentialConfigured: type === "openai",
      });
      expect(JSON.stringify(catalog)).not.toContain("fixture-custom-key");
      await fixture.service.add({
        profileId: "alias-model",
        model: "fixture-second",
        providerId,
      });
      const after = await fixture.readConfig();
      expect(after.models.providers[providerId]).toEqual(provider);
      expect(after.models.profiles["alias-model"]).toMatchObject({
        provider: providerId,
        context: {
          formatTokenAccounting: {
            mode: type === "ollama" ? "none" : "estimate",
          },
        },
        ...(type === "openai"
          ? { execution: { policy: "execution-agent-v1" } }
          : {}),
      });
      if (type === "openai")
        expect(process.env.MODEL_FIXTURE_KEY).toBe("fixture-custom-key");
    },
  );

  test("isolates new OpenAI credentials from existing providers and punctuation-similar IDs", async () => {
    await writeFile(
      fixture.envPath,
      `${await fixture.readEnv()}OPENAI_API_KEY="fixture-preserved-global"\n`,
    );
    const result = await fixture.service.add({
      profileId: "first-cloud",
      model: "fixture-cloud",
      newProvider: { id: "work-cloud", type: "openai" },
      apiKey: "fixture-first-private",
    });
    await fixture.service.add({
      profileId: "second-cloud",
      model: "fixture-cloud",
      newProvider: { id: "work_cloud", type: "openai" },
      apiKey: "fixture-second-private",
    });
    const config = await fixture.readConfig();
    const first = config.models.providers["work-cloud"].apiKeyEnv;
    const second = config.models.providers.work_cloud.apiKeyEnv;
    expect(first).toMatch(/^ABOT_MODEL_PROVIDER_[A-F0-9]+_API_KEY$/u);
    expect(first).not.toBe(second);
    expect(await fixture.readEnv()).toContain(
      'OPENAI_API_KEY="fixture-preserved-global"',
    );
    expect(process.env[first]).toBe("fixture-first-private");
    expect(process.env[second]).toBe("fixture-second-private");
    expect(JSON.stringify(result)).not.toContain("fixture-first-private");
    expect(JSON.stringify(config)).not.toContain("fixture-first-private");
    expect((await stat(fixture.envPath)).mode & 0o777).toBe(0o600);
  });

  test("completes a missing custom OpenAI key but rejects rotation of a configured key", async () => {
    const config = await fixture.readConfig();
    config.models.providers.cloud = {
      type: "openai",
      apiKeyEnv: "MODEL_FIXTURE_KEY",
    };
    await fixture.writeConfig(config);
    await fixture.service.add({
      profileId: "cloud-one",
      model: "fixture",
      providerId: "cloud",
      apiKey: "fixture-saved-key",
    });
    const before = await fixture.readConfig();
    const env = await fixture.readEnv();
    await expect(
      fixture.service.add({
        profileId: "cloud-two",
        model: "fixture",
        providerId: "cloud",
        apiKey: "fixture-replacement-key",
      }),
    ).rejects.toMatchObject({
      code: "credential_already_configured",
      statusCode: 409,
    });
    expect(await fixture.readConfig()).toEqual(before);
    expect(await fixture.readEnv()).toBe(env);
  });

  test("keeps credential persistence on config-save failure and retries without another secret or duplicate profile", async () => {
    const before = await fixture.readConfig();
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockRejectedValueOnce(
      new Error("fixture-private-upstream-secret"),
    );
    const input = {
      profileId: "retry-profile",
      model: "fixture",
      newProvider: { id: "retry-cloud", type: "openai" },
    };
    const failure = await fixture.service
      .add({ ...input, apiKey: "fixture-private-retry-key" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "model_save_failed",
      credentialSaved: true,
    });
    expect(String(failure)).not.toContain("fixture-private-upstream-secret");
    expect(await fixture.readConfig()).toEqual(before);
    expect(await fixture.readEnv()).toContain("fixture-private-retry-key");
    await expect(fixture.service.add(input)).resolves.toMatchObject({
      model: { profileId: "retry-profile" },
    });
    expect(Object.keys((await fixture.readConfig()).models.profiles)).toEqual([
      "default",
      "retry-profile",
    ]);
  });

  test("returns the committed identity when the canonical writer fails after committing", async () => {
    const save = dashboard.saveConfigDashboardFile;
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
      async (input) => {
        await save(input);
        throw new Error("fixture-post-commit-read-failure");
      },
    );
    await expect(
      fixture.service.add({
        profileId: "committed",
        model: "fixture-committed",
        providerId: "ollama",
      }),
    ).resolves.toMatchObject({
      model: { profileId: "committed", providerId: "ollama" },
      restartRequired: true,
    });
    expect(
      (await fixture.readConfig()).models.profiles.committed,
    ).toMatchObject({ model: "fixture-committed" });
    expect(dashboard.saveConfigDashboardFile).toHaveBeenCalledOnce();
  });

  test("does not classify a different persisted candidate as successful even when the new model exists", async () => {
    const save = dashboard.saveConfigDashboardFile;
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
      async (input) => {
        const candidate = input.config as Record<string, unknown>;
        await save({
          ...input,
          config: { ...candidate, logging: { enabled: false } },
        });
        throw new Error("fixture-different-commit");
      },
    );
    await expect(
      fixture.service.add({
        profileId: "mismatch",
        model: "fixture",
        providerId: "ollama",
      }),
    ).rejects.toMatchObject({ code: "model_save_failed" });
    expect((await fixture.readConfig()).models.profiles.mismatch).toMatchObject(
      { model: "fixture" },
    );
  });

  test("serializes distinct and colliding additions through aliases of the same config file", async () => {
    const alias = join(fixture.rootDir, "alias.json");
    await symlink(fixture.configPath, alias);
    const second = new ModelSetupService({
      rootDir: fixture.rootDir,
      getConfigPath: () => alias,
    });
    await Promise.all([
      fixture.service.add({
        profileId: "first",
        model: "fixture-one",
        providerId: "ollama",
      }),
      second.add({
        profileId: "second",
        model: "fixture-two",
        providerId: "ollama",
      }),
    ]);
    expect((await second.catalog()).profileIds).toEqual(
      expect.arrayContaining(["default", "first", "second"]),
    );
    const collision = await Promise.allSettled([
      fixture.service.add({
        profileId: "same",
        model: "fixture-one",
        providerId: "ollama",
      }),
      second.add({
        profileId: "same",
        model: "fixture-two",
        providerId: "ollama",
      }),
    ]);
    expect(
      collision.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      collision.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "model_profile_exists" } });
    expect(
      Object.keys((await fixture.readConfig()).models.profiles),
    ).toHaveLength(4);
  });

  test("validates the complete candidate before persisting a new credential", async () => {
    const config = await fixture.readConfig();
    config.models.defaults = { profileId: "missing-profile" };
    await fixture.writeConfig(config);
    const env = await fixture.readEnv();
    await expect(
      fixture.service.add({
        profileId: "invalid",
        model: "fixture",
        newProvider: { id: "invalid-cloud", type: "openai" },
        apiKey: "fixture-should-not-save",
      }),
    ).rejects.toThrow();
    expect(await fixture.readConfig()).toEqual(config);
    expect(await fixture.readEnv()).toBe(env);
  });
});
