import * as setupCredentials from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import * as setupDraft from "../../web-ui/local-runtime/runtime-setup-draft.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { loadRuntimeConfig } from "../config.js";

const artifactRoot = resolve(".codex/artifacts/onboarding-back-edit-20260908");
let rootDir = "";
let configPath: string | undefined;
const activate = vi.fn(async () => ({ status: "ready" as const }));
function service() {
  return new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath,
    configure: (path) => {
      configPath = path;
    },
    activate,
  });
}
const connection = {
  provider: "ollama",
  model: "first-model",
  baseUrl: "http://127.0.0.1:11434",
  contextWindowTokens: 32768,
  deferActivation: true,
};
async function savedConfig() {
  return JSON.parse(await readFile(configPath!, "utf8"));
}
async function updateConfig(update: (config: Record<string, any>) => void) {
  const config = await savedConfig();
  update(config);
  await writeFile(configPath!, JSON.stringify(config));
}

beforeEach(async () => {
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "connection-edit-"));
  configPath = undefined;
  activate.mockClear();
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe("unfinished setup connection editing", () => {
  test("reopens after refresh and persists corrected address, model, and context", async () => {
    const first = await service().save(connection);
    expect(first.setup).toMatchObject({
      status: "ready",
      editableConnection: { revision: expect.any(String) },
    });
    const reopened = service();
    expect((await reopened.status()).editableConnection).toEqual(
      first.setup.editableConnection,
    );
    const result = await reopened.save({
      ...connection,
      baseUrl: "http://172.31.160.1:11434",
      model: "corrected-model",
      contextWindowTokens: 131072,
      connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(result.setup.editableConnection!.revision).not.toBe(
      first.setup.editableConnection!.revision,
    );
    const config = loadRuntimeConfig({ rootDir, configPath });
    expect(config.models?.providers?.ollama.baseUrl).toBe(
      "http://172.31.160.1:11434",
    );
    expect(config.models?.profiles?.default).toMatchObject({
      model: "corrected-model",
      contextWindowTokens: 131072,
    });
    expect(activate).not.toHaveBeenCalled();
    expect((await stat(configPath! + ".web-setup.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  test("switches provider in the same owned model without retaining unused draft providers", async () => {
    const initial = await service().save(connection);
    const switched = await service().save({
      provider: "openai",
      model: "cloud-model",
      apiKey: "fixture-cloud-key",
      deferActivation: true,
      contextWindowTokens: 128000,
      connectionRevision: initial.setup.editableConnection!.revision,
    });
    const config = loadRuntimeConfig({ rootDir, configPath });
    expect(config.models?.profiles?.default).toMatchObject({
      provider: "openai",
      model: "cloud-model",
    });
    expect(config.models?.providers?.ollama).toBeUndefined();
    expect(config.models?.providers?.openai.type).toBe("openai");
    const openaiModel = JSON.parse(
      await readFile(
        join(dirname(configPath!), "models/default.config.json"),
        "utf8",
      ),
    );
    expect(openaiModel).toMatchObject({
      label: "cloud-model",
      execution: { policy: "execution-agent-v1" },
      context: { formatTokenAccounting: { mode: "estimate" } },
    });
    expect(JSON.stringify(switched)).not.toContain("fixture-cloud-key");
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      "fixture-cloud-key",
    );
    await service().save({
      ...connection,
      connectionRevision: switched.setup.editableConnection!.revision,
    });
    expect((await savedConfig()).models.providers.openai).toBeUndefined();
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      "fixture-cloud-key",
    );
    const ollamaModel = JSON.parse(
      await readFile(
        join(dirname(configPath!), "models/default.config.json"),
        "utf8",
      ),
    );
    expect(ollamaModel).toMatchObject({
      label: connection.model,
      context: { formatTokenAccounting: { mode: "none" } },
    });
    expect(ollamaModel.execution).toBeUndefined();
  });

  test("rejects stale tabs and saves without a revision before altering files", async () => {
    const instance = service();
    const first = await instance.save(connection);
    const revision = first.setup.editableConnection!.revision;
    await instance.save({
      ...connection,
      model: "winner",
      connectionRevision: revision,
    });
    const before = await readFile(configPath!, "utf8");
    const beforeModel = await readFile(
      join(dirname(configPath!), "models/default.config.json"),
      "utf8",
    );
    for (const input of [
      { ...connection, model: "stale", connectionRevision: revision },
      { ...connection, model: "without-revision" },
    ])
      await expect(instance.save(input)).rejects.toMatchObject({
        code: "setup_configuration_changed",
        statusCode: 409,
      });
    expect(await readFile(configPath!, "utf8")).toBe(before);
    expect(
      await readFile(
        join(dirname(configPath!), "models/default.config.json"),
        "utf8",
      ),
    ).toBe(beforeModel);
  });

  test("preserves optional-step configuration and invalidates only a changed embedding connection", async () => {
    const first = await service().save(connection);
    await updateConfig((config) => {
      config.plugins = { enabled: false };
      config.models.embeddingProfiles = {
        "memory-embedding": { provider: "ollama", model: "embedding-model" },
      };
      config.longTermMemory = {
        enabled: true,
        emitClientEvents: true,
        embeddingProfileId: "memory-embedding",
      };
    });
    const result = await service().save({
      ...connection,
      baseUrl: "http://other-host:11434",
      connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(result.embeddingInvalidated).toBe(true);
    const config = await savedConfig();
    expect(config.plugins).toEqual({ enabled: false });
    expect(config.longTermMemory).toMatchObject({
      enabled: false,
      emitClientEvents: true,
    });
    expect(config.models.embeddingProfiles["memory-embedding"].model).toBe(
      "embedding-model",
    );
  });

  test("retains enabled embeddings when only chat model/context or a different provider changes", async () => {
    const first = await service().save(connection);
    await updateConfig((config) => {
      config.models.providers["embedding-server"] = {
        type: "ollama",
        baseUrl: "http://embedding-server:11434",
      };
      config.models.embeddingProfiles = {
        "memory-embedding": {
          provider: "embedding-server",
          model: "embedding-model",
        },
      };
      config.longTermMemory = {
        enabled: true,
        embeddingProfileId: "memory-embedding",
      };
    });
    const changed = await service().save({
      ...connection,
      baseUrl: "http://new-chat-server:11434",
      connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(changed.embeddingInvalidated).toBe(false);
    expect((await savedConfig()).longTermMemory.enabled).toBe(true);
    expect(
      (await savedConfig()).models.providers["embedding-server"].baseUrl,
    ).toBe("http://embedding-server:11434");
  });

  test("does not take ownership of or overwrite pre-existing providers", async () => {
    configPath = join(rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            openai: { type: "openai", apiKeyEnv: "EXISTING_API_KEY" },
          },
        },
      }),
    );
    const first = await service().save(connection);
    const before = await readFile(configPath, "utf8");
    await expect(
      service().save({
        provider: "openai",
        model: "cloud-model",
        apiKey: "fixture-ignored-key",
        deferActivation: true,
        connectionRevision: first.setup.editableConnection!.revision,
      }),
    ).rejects.toMatchObject({ code: "setup_provider_conflict" });
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  test("external model edits revoke draft ownership and cannot be overwritten by an old tab", async () => {
    const first = await service().save(connection);
    const modelPath = join(dirname(configPath!), "models/default.config.json");
    const model = JSON.parse(await readFile(modelPath, "utf8"));
    model.contextWindowTokens = 64000;
    await writeFile(modelPath, JSON.stringify(model));
    expect((await service().status()).editableConnection).toBeUndefined();
    await expect(
      service().save({
        ...connection,
        connectionRevision: first.setup.editableConnection!.revision,
      }),
    ).rejects.toMatchObject({ code: "setup_configuration_changed" });
    expect(
      JSON.parse(await readFile(modelPath, "utf8")).contextWindowTokens,
    ).toBe(64000);
  });

  test("rolls back a new scaffold if its ownership receipt cannot be written", async () => {
    const target = join(rootDir, "local/runtime.config.json");
    await mkdir(target + ".web-setup.json", { recursive: true });
    await expect(service().save(connection)).rejects.toMatchObject({
      code: "setup_configuration_changed",
    });
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(dirname(target), "models/default.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(activate).not.toHaveBeenCalled();
  });

  test("restores prior config if creating the receipt fails", async () => {
    configPath = join(rootDir, "runtime.config.json");
    const original = {
      logging: { enabled: false },
      plugins: { enabled: false },
    };
    await writeFile(configPath, JSON.stringify(original));
    vi.spyOn(setupDraft, "createRuntimeSetupDraft").mockRejectedValueOnce(
      new Error("fixture-create-receipt"),
    );
    await expect(service().save(connection)).rejects.toThrow(
      "fixture-create-receipt",
    );
    expect(await savedConfig()).toEqual(original);
    await expect(
      stat(join(rootDir, "models/default.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps a concurrently edited model when initial draft recording detects a conflict", async () => {
    const createDraft = setupDraft.createRuntimeSetupDraft;
    const externallyEdited = {
      provider: "ollama",
      model: "external-owner",
      contextWindowTokens: 65536,
    };
    vi.spyOn(setupDraft, "createRuntimeSetupDraft").mockImplementationOnce(
      async (...args) => {
        await writeFile(
          join(dirname(args[0].path), "models/default.config.json"),
          JSON.stringify(externallyEdited),
        );
        return createDraft(...args);
      },
    );
    await expect(service().save(connection)).rejects.toMatchObject({
      code: "setup_configuration_changed",
    });
    expect(
      JSON.parse(
        await readFile(
          join(dirname(configPath!), "models/default.config.json"),
          "utf8",
        ),
      ),
    ).toEqual(externallyEdited);
    await expect(stat(configPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("revokes ownership when the model path is replaced with a symlink", async () => {
    const first = await service().save(connection);
    const modelPath = join(dirname(configPath!), "models/default.config.json");
    const alternatePath = join(rootDir, "preserved-model.json");
    const raw = await readFile(modelPath, "utf8");
    await writeFile(alternatePath, raw);
    await rm(modelPath);
    await symlink(alternatePath, modelPath);
    expect((await service().status()).editableConnection).toBeUndefined();
    await expect(
      service().save({
        ...connection,
        model: "must-not-write",
        connectionRevision: first.setup.editableConnection!.revision,
      }),
    ).rejects.toMatchObject({ code: "setup_configuration_changed" });
    expect(await readFile(alternatePath, "utf8")).toBe(raw);
  });

  test("does not let a malformed receipt block established configuration status", async () => {
    await service().save(connection);
    await writeFile(configPath! + ".web-setup.json", "malformed receipt");
    expect(await service().status()).toMatchObject({ status: "ready" });
    expect((await service().status()).editableConnection).toBeUndefined();
  });

  test("changed API keys require embedding revalidation on their shared provider", async () => {
    const first = await service().save({
      provider: "openai",
      model: "cloud-model",
      apiKey: "fixture-old-key",
      deferActivation: true,
    });
    await updateConfig((config) => {
      config.models.embeddingProfiles = {
        "memory-embedding": { provider: "openai", model: "embedding-model" },
      };
      config.longTermMemory = {
        enabled: true,
        embeddingProfileId: "memory-embedding",
      };
    });
    const result = await service().save({
      provider: "openai",
      model: "cloud-model",
      apiKey: "fixture-corrected-key",
      deferActivation: true,
      connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(result.embeddingInvalidated).toBe(true);
    expect((await savedConfig()).longTermMemory.enabled).toBe(false);
  });

  test("a credential save failure remains recoverable after refresh without re-scaffolding", async () => {
    vi.spyOn(
      setupCredentials,
      "persistRuntimeSetupCredentials",
    ).mockRejectedValueOnce(new Error("fixture-save-failed"));
    const input = {
      provider: "openai",
      model: "cloud-model",
      apiKey: "fixture-key",
      deferActivation: true,
    };
    await expect(service().save(input)).rejects.toThrow("fixture-save-failed");
    const resumed = await service().status();
    expect(resumed.status).toBe("required");
    expect(resumed.editableConnection).toBeDefined();
    const result = await service().save({
      ...input,
      connectionRevision: resumed.editableConnection!.revision,
    });
    expect(result.setup.existingModel?.model).toBe("cloud-model");
    expect(await readFile(join(rootDir, ".env"), "utf8")).toContain(
      "fixture-key",
    );
  });

  test("rolls back a connection edit if its next ownership receipt cannot be committed", async () => {
    const initial = await service().save(connection);
    const originalConfig = await savedConfig();
    const modelPath = join(dirname(configPath!), "models/default.config.json");
    const originalModel = JSON.parse(await readFile(modelPath, "utf8"));
    vi.spyOn(setupDraft, "writeRuntimeSetupDraft").mockRejectedValueOnce(
      new Error("fixture-receipt-write"),
    );
    await expect(
      service().save({
        ...connection,
        model: "must-rollback",
        baseUrl: "http://changed:11434",
        connectionRevision: initial.setup.editableConnection!.revision,
      }),
    ).rejects.toThrow("fixture-receipt-write");
    expect(await savedConfig()).toEqual(originalConfig);
    expect(JSON.parse(await readFile(modelPath, "utf8"))).toEqual(
      originalModel,
    );
    expect((await service().status()).editableConnection).toEqual(
      initial.setup.editableConnection,
    );
  });

  test("finalizes only the applied revision and preserves an established connection thereafter", async () => {
    const instance = service();
    const first = await instance.save(connection);
    const second = await instance.save({
      ...connection,
      model: "latest",
      connectionRevision: first.setup.editableConnection!.revision,
    });
    expect(
      await instance.finalize(first.setup.editableConnection!.revision),
    ).toBe(false);
    expect((await instance.status()).editableConnection).toEqual(
      second.setup.editableConnection,
    );
    expect(
      await instance.finalize(second.setup.editableConnection!.revision),
    ).toBe(true);
    expect(await instance.status()).toMatchObject({ status: "ready" });
    expect((await instance.status()).editableConnection).toBeUndefined();
    await expect(
      instance.save({ ...connection, model: "overwrite" }),
    ).rejects.toMatchObject({ code: "setup_configuration_exists" });
    await expect(
      instance.save({
        ...connection,
        connectionRevision: second.setup.editableConnection!.revision,
      }),
    ).rejects.toMatchObject({ code: "setup_configuration_changed" });
  });
});
