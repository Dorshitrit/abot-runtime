import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import * as credentials from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import * as provider from "../../web-ui/local-runtime/model-setup-provider.js";
import { isolatedProviderCredentialName } from "../../web-ui/local-runtime/provider-credential-identity.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-save-repair-20260908/model-retry",
  );
});
afterEach(async () => {
  await fixture.cleanup();
});

const request = {
  profileId: "retried-cloud-model",
  model: "fixture-cloud-model",
  contextWindowTokens: 65536,
  newProvider: { id: "retried-cloud", type: "openai" },
};
const originalKey = "fixture-original-alias-key";

function recreatedService() {
  return new ModelSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => fixture.configPath,
  });
}

async function persistedFiles() {
  const declarations = Object.entries<{ configRef?: string }>(
    (await fixture.readConfig()).models.profiles,
  );
  return {
    config: await readFile(fixture.configPath, "utf8"),
    env: await fixture.readEnv(),
    models: Object.fromEntries(
      await Promise.all(
        declarations.flatMap(([id, profile]) => {
          if (!profile.configRef) return [];
          const path = resolve(dirname(fixture.configPath), profile.configRef);
          return [readFile(path, "utf8").then((bytes) => [id, bytes])];
        }),
      ),
    ),
  };
}

async function commitThenAddCredentialAlias() {
  const committed = await fixture.service.add({
    ...request,
    apiKey: originalKey,
  });
  const config = await fixture.readConfig();
  config.models.providers["unrelated-alias"] = {
    ...config.models.providers[request.newProvider.id],
  };
  config.logging = { ...config.logging, enabled: false };
  await fixture.writeConfig(config);
  return committed;
}

describe("committed model retries after unrelated credential aliases are added", () => {
  test.each([undefined, originalKey])(
    "confirms exact saved identity without new writes when retry apiKey is %s",
    async (apiKey) => {
      const committed = await commitThenAddCredentialAlias();
      const before = await persistedFiles();
      const save = vi.spyOn(dashboard, "saveConfigDashboardFile");
      const saveCredential = vi.spyOn(
        credentials,
        "persistRuntimeSetupCredentials",
      );

      await expect(
        recreatedService().add({ ...request, ...(apiKey ? { apiKey } : {}) }),
      ).resolves.toEqual(committed);

      expect(await persistedFiles()).toEqual(before);
      expect(save).not.toHaveBeenCalled();
      expect(saveCredential).not.toHaveBeenCalled();
    },
  );

  test.each([
    { type: "ollama" },
    { apiKeyEnv: "UNRELATED_API_KEY" },
    { baseUrl: "https://changed.example.test" },
  ])(
    "rejects changed saved provider identity despite its alias: %j",
    async (change) => {
      await commitThenAddCredentialAlias();
      const config = await fixture.readConfig();
      Object.assign(config.models.providers[request.newProvider.id], change);
      await fixture.writeConfig(config);
      const before = await persistedFiles();

      await expect(recreatedService().add(request)).rejects.toMatchObject({
        code: "model_profile_exists",
        statusCode: 409,
      });
      expect(await persistedFiles()).toEqual(before);
    },
  );

  test("rejects changed saved profile identity despite an unchanged provider and alias", async () => {
    await commitThenAddCredentialAlias();
    const profile = await fixture.readModelProfile(request.profileId);
    profile.model = "externally-edited";
    await fixture.writeModelProfile(request.profileId, profile);
    const before = await persistedFiles();

    await expect(recreatedService().add(request)).rejects.toMatchObject({
      code: "model_profile_exists",
      statusCode: 409,
    });
    expect(await persistedFiles()).toEqual(before);
  });

  test("still refuses credential rotation on a committed retry with aliases", async () => {
    await commitThenAddCredentialAlias();
    const before = await persistedFiles();

    await expect(
      recreatedService().add({ ...request, apiKey: "fixture-replacement" }),
    ).rejects.toMatchObject({
      code: "credential_already_configured",
      statusCode: 409,
    });
    expect(await persistedFiles()).toEqual(before);
  });

  test.each([undefined, "fixture-replacement"])(
    "does not repair a missing saved credential on retry with apiKey %s",
    async (apiKey) => {
      await commitThenAddCredentialAlias();
      delete process.env[
        isolatedProviderCredentialName(request.newProvider.id)
      ];
      await writeFile(fixture.envPath, "");
      const before = await persistedFiles();

      await expect(
        recreatedService().add({ ...request, ...(apiKey ? { apiKey } : {}) }),
      ).rejects.toMatchObject({ code: "model_credential_required" });
      expect(await persistedFiles()).toEqual(before);
    },
  );

  test("retains the root revision guard while confirming a retry with aliases", async () => {
    await commitThenAddCredentialAlias();
    const prepare = provider.prepareModelCredential;
    const beforeEnv = await fixture.readEnv();
    vi.spyOn(provider, "prepareModelCredential").mockImplementationOnce(
      async (...args) => {
        const result = await prepare(...args);
        const config = await fixture.readConfig();
        config.logging = { ...config.logging, enabled: true };
        await fixture.writeConfig(config);
        return result;
      },
    );

    await expect(recreatedService().add(request)).rejects.toMatchObject({
      code: "config_changed",
      statusCode: 409,
    });
    expect((await fixture.readConfig()).logging.enabled).toBe(true);
    expect(await fixture.readEnv()).toBe(beforeEnv);
  });

  test("still rejects a credential alias collision when creating a genuinely new provider", async () => {
    const config = await fixture.readConfig();
    config.models.providers["preexisting-alias"] = {
      type: "openai",
      apiKeyEnv: isolatedProviderCredentialName(request.newProvider.id),
    };
    await fixture.writeConfig(config);
    const before = await persistedFiles();

    await expect(
      fixture.service.add({ ...request, apiKey: originalKey }),
    ).rejects.toMatchObject({
      code: "model_credential_conflict",
      statusCode: 409,
    });
    expect(await persistedFiles()).toEqual(before);
  });
});
