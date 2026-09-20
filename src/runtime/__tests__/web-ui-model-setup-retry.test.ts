import { readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelSetupRoutes } from "../../web-ui/local-runtime/model-setup-routes.js";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import * as credentials from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import * as provider from "../../web-ui/local-runtime/model-setup-provider.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-apply-recovery-20260908/model-retry",
  );
});
afterEach(async () => {
  await fixture.cleanup();
});

const input = {
  profileId: "retried",
  model: "fixture-retry",
  contextWindowTokens: 65536,
  providerId: "ollama",
};
function recreatedService(configPath = fixture.configPath) {
  return new ModelSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => configPath,
  });
}
async function persistedFiles() {
  return {
    config: await readFile(fixture.configPath, "utf8"),
    env: await fixture.readEnv(),
    model: await readFile(
      join(fixture.rootDir, "local/models/default.config.json"),
      "utf8",
    ),
  };
}

describe("committed model addition retry", () => {
  test("confirms a retry through the actual HTTP route after the first committed response socket is lost", async () => {
    let pendingResponse: import("node:http").ServerResponse;
    const routes = new ModelSetupRoutes(fixture.service);
    const server = createServer((request, response) => {
      pendingResponse = response;
      void routes.handle({
        method: request.method!,
        route: "runtime/config/models",
        request,
        response,
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const add = fixture.service.add.bind(fixture.service);
    vi.spyOn(fixture.service, "add").mockImplementationOnce(async (body) => {
      const result = await add(body);
      pendingResponse.destroy();
      return result;
    });
    const post = () =>
      fetch(origin + "/web-api/runtime/config/models", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(input),
      });
    try {
      await expect(post()).rejects.toThrow();
      const before = await persistedFiles();
      const response = await post();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        model: { profileId: input.profileId },
        restartRequired: true,
      });
      expect(await persistedFiles()).toEqual(before);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("does not repair a missing credential as a side effect of acknowledging an existing profile", async () => {
    const request = {
      ...input,
      providerId: undefined,
      newProvider: { id: "missing-cloud", type: "openai" },
    };
    await fixture.service.add({ ...request, apiKey: "fixture-original" });
    const config = await fixture.readConfig();
    const name = config.models.providers["missing-cloud"].apiKeyEnv;
    delete process.env[name];
    await writeFile(fixture.envPath, "");
    const before = await persistedFiles();
    await expect(fixture.service.add(request)).rejects.toMatchObject({
      code: "model_credential_required",
    });
    await expect(
      fixture.service.add({ ...request, apiKey: "fixture-replacement" }),
    ).rejects.toMatchObject({
      code: "model_credential_required",
      statusCode: 409,
    });
    expect(await persistedFiles()).toEqual(before);
  });

  test("accepts an identical key on a committed retry without persisting it again", async () => {
    const request = {
      ...input,
      providerId: undefined,
      newProvider: { id: "same-cloud", type: "openai" },
      apiKey: "fixture-identical",
    };
    const result = await fixture.service.add(request);
    const before = await persistedFiles();
    const saveKey = vi.spyOn(credentials, "persistRuntimeSetupCredentials");
    await expect(fixture.service.add(request)).resolves.toEqual(result);
    expect(saveKey).not.toHaveBeenCalled();
    expect(await persistedFiles()).toEqual(before);
  });

  test("recovers the exact committed identity after its successful response is lost, without another write", async () => {
    await expect(
      fixture.service.add(input).then(() => {
        throw new Error("fixture response lost");
      }),
    ).rejects.toThrow("fixture response lost");
    const before = await persistedFiles();
    const save = vi.spyOn(dashboard, "saveConfigDashboardFile");
    const saveKey = vi.spyOn(credentials, "persistRuntimeSetupCredentials");
    await expect(recreatedService().add(input)).resolves.toEqual({
      model: {
        profileId: "retried",
        providerId: "ollama",
        provider: "ollama",
        model: "fixture-retry",
      },
      restartRequired: true,
    });
    expect(await persistedFiles()).toEqual(before);
    expect(save).not.toHaveBeenCalled();
    expect(saveKey).not.toHaveBeenCalled();
  });

  test.each(["openai", "ollama"])(
    "recognizes the exact new %s connection and preserves its saved credential",
    async (type) => {
      const request = {
        profileId: "new-connection",
        model: "fixture-new",
        newProvider: {
          id: "new-connection",
          type,
          ...(type === "ollama" ? { baseUrl: "http://127.0.0.1:19999" } : {}),
        },
      };
      const first = await fixture.service.add({
        ...request,
        ...(type === "openai" ? { apiKey: "fixture-private-retry" } : {}),
      });
      const before = await persistedFiles();
      const save = vi.spyOn(dashboard, "saveConfigDashboardFile");
      const saveKey = vi.spyOn(credentials, "persistRuntimeSetupCredentials");
      await expect(recreatedService().add(request)).resolves.toEqual(first);
      expect(await persistedFiles()).toEqual(before);
      expect(save).not.toHaveBeenCalled();
      expect(saveKey).not.toHaveBeenCalled();
      expect(JSON.stringify(first)).not.toContain("fixture-private-retry");
    },
  );

  test("recognizes an explicit template context window when the first request omitted it", async () => {
    const { contextWindowTokens: _context, ...request } = input;
    const first = await fixture.service.add(request);
    const config = await fixture.readConfig();
    await expect(
      fixture.service.add({
        ...request,
        contextWindowTokens: config.models.profiles.retried.contextWindowTokens,
      }),
    ).resolves.toEqual(first);
  });

  test("preserves unrelated edits and defaults made after the first response", async () => {
    const first = await fixture.service.add(input);
    const config = await fixture.readConfig();
    config.logging = { ...config.logging, enabled: false };
    config.models.defaults = {
      ...config.models.defaults,
      profileId: "retried",
    };
    await fixture.writeConfig(config);
    const before = await persistedFiles();
    await expect(recreatedService().add(input)).resolves.toEqual(first);
    expect(await persistedFiles()).toEqual(before);
  });

  test.each([
    { model: "different-model" },
    { contextWindowTokens: 32768 },
    { providerId: "other" },
  ])("rejects conflicting request identity: %j", async (change) => {
    await fixture.service.add(input);
    const config = await fixture.readConfig();
    config.models.providers.other = { ...config.models.providers.ollama };
    await fixture.writeConfig(config);
    const before = await persistedFiles();
    await expect(
      fixture.service.add({ ...input, ...change }),
    ).rejects.toMatchObject({ code: "model_profile_exists", statusCode: 409 });
    expect(await persistedFiles()).toEqual(before);
  });

  test.each<[string, unknown]>([
    ["capabilities", { deny: ["filesystem"] }],
    ["context", { formatTokenAccounting: { mode: "estimate" } }],
    ["execution", { policy: "execution-agent-v1" }],
    ["label", "Edited label"],
  ])(
    "does not adopt a profile whose %s configuration was edited",
    async (field, value) => {
      await fixture.service.add(input);
      const config = await fixture.readConfig();
      config.models.profiles.retried[field] = value;
      await fixture.writeConfig(config);
      const before = await persistedFiles();
      await expect(fixture.service.add(input)).rejects.toMatchObject({
        code: "model_profile_exists",
        statusCode: 409,
      });
      expect(await persistedFiles()).toEqual(before);
    },
  );

  test("rejects a changed new-provider connection even when its model profile still matches", async () => {
    const request = {
      ...input,
      providerId: undefined,
      newProvider: { id: "new-local", type: "ollama" },
    };
    await fixture.service.add(request);
    const config = await fixture.readConfig();
    config.models.providers["new-local"].baseUrl = "http://127.0.0.1:29999";
    await fixture.writeConfig(config);
    const before = await persistedFiles();
    await expect(fixture.service.add(request)).rejects.toMatchObject({
      code: "model_profile_exists",
      statusCode: 409,
    });
    expect(await persistedFiles()).toEqual(before);
  });

  test("refuses credential rotation on an exact model retry", async () => {
    const request = {
      ...input,
      providerId: undefined,
      newProvider: { id: "new-cloud", type: "openai" },
    };
    await fixture.service.add({ ...request, apiKey: "fixture-original" });
    const before = await persistedFiles();
    await expect(
      fixture.service.add({ ...request, apiKey: "fixture-replacement" }),
    ).rejects.toMatchObject({
      code: "credential_already_configured",
      statusCode: 409,
    });
    expect(await persistedFiles()).toEqual(before);
  });

  test("serializes identical additions through separate service instances and config aliases", async () => {
    const alias = join(fixture.rootDir, "config-alias.json");
    await symlink(fixture.configPath, alias);
    const save = vi.spyOn(dashboard, "saveConfigDashboardFile");
    const results = await Promise.all([
      fixture.service.add(input),
      recreatedService(alias).add(input),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(save).toHaveBeenCalledOnce();
    expect(Object.keys((await fixture.readConfig()).models.profiles)).toEqual([
      "default",
      "retried",
    ]);
  });

  test("keeps conflicting concurrent additions as one winner and one 409", async () => {
    const results = await Promise.allSettled([
      fixture.service.add(input),
      recreatedService().add({ ...input, model: "other-model" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "model_profile_exists", statusCode: 409 },
    });
  });

  test("rejects an external edit completed while the committed retry is being checked", async () => {
    await fixture.service.add(input);
    const prepare = provider.prepareModelCredential;
    vi.spyOn(provider, "prepareModelCredential").mockImplementationOnce(
      async (...args) => {
        const result = await prepare(...args);
        const config = await fixture.readConfig();
        config.models.profiles.retried.model = "external-edit";
        await fixture.writeConfig(config);
        return result;
      },
    );
    await expect(fixture.service.add(input)).rejects.toMatchObject({
      code: "config_changed",
      statusCode: 409,
    });
    expect((await fixture.readConfig()).models.profiles.retried.model).toBe(
      "external-edit",
    );
  });
});
