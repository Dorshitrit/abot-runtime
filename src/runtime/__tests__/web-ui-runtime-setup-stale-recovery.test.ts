import * as setupDraft from "../../web-ui/local-runtime/runtime-setup-draft.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { loadRuntimeConfig } from "../config.js";

const artifacts = resolve(".codex/artifacts/pr71-stale-draft-recovery-20260908");
const connection = {
  provider: "ollama",
  model: "original-chat",
  baseUrl: "http://127.0.0.1:11434",
  contextWindowTokens: 32768,
  deferActivation: true,
};
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

async function source() {
  return JSON.parse(await readFile(configPath!, "utf8"));
}

async function removeProfiles(removeField = false) {
  const config = await source();
  if (removeField) delete config.models.profiles;
  else config.models.profiles = {};
  await writeFile(configPath!, JSON.stringify(config));
}

function originalModelPath() {
  return join(dirname(configPath!), "models/default.config.json");
}

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "stale-recovery-"));
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

describe("stale unfinished setup recovery", () => {
  test.each([false, true])(
    "fresh setup recovers after externally removing profiles (delete field: %s)",
    async (removeField) => {
      const initial = await service().save(connection);
      const oldRevision = initial.setup.editableConnection!.revision;
      const orphanPath = originalModelPath();
      const orphanContent = await readFile(orphanPath, "utf8");
      await removeProfiles(removeField);

      const reopened = service();
      const status = await reopened.status();
      expect(status.status).toBe("required");
      expect(status.editableConnection).toBeUndefined();
      const recovered = await reopened.save({
        ...connection,
        model: "recovered-chat",
      });
      expect(recovered.setup.status).toBe("ready");
      expect(recovered.setup.editableConnection?.revision).toEqual(
        expect.any(String),
      );
      expect(recovered.setup.editableConnection!.revision).not.toBe(oldRevision);
      expect(await readFile(orphanPath, "utf8")).toBe(orphanContent);
      expect(
        loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default,
      ).toMatchObject({ provider: "ollama", model: "recovered-chat" });

      const beforeRejectedSave = await readFile(configPath!, "utf8");
      for (const input of [
        { ...connection, model: "stale-tab", connectionRevision: oldRevision },
        { ...connection, model: "missing-revision" },
      ])
        await expect(reopened.save(input)).rejects.toMatchObject({
          code: "setup_configuration_changed",
          statusCode: 409,
        });
      expect(await readFile(configPath!, "utf8")).toBe(beforeRejectedSave);

      const edited = await service().save({
        ...connection,
        model: "recovered-edited-chat",
        connectionRevision: recovered.setup.editableConnection!.revision,
      });
      expect(edited.setup.editableConnection!.revision).not.toBe(
        recovered.setup.editableConnection!.revision,
      );
      const completed = await service().save({
        ...connection,
        model: "recovered-edited-chat",
        deferActivation: false,
        connectionRevision: edited.setup.editableConnection!.revision,
      });
      expect(completed.activation.status).toBe("ready");
      expect(completed.setup.editableConnection).toBeUndefined();
      expect(activate).toHaveBeenCalledOnce();
      expect(await readFile(orphanPath, "utf8")).toBe(orphanContent);
      expect(
        loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.model,
      ).toBe("recovered-edited-chat");
    },
  );

  test("preserves an externally edited orphan model, existing providers and optional settings", async () => {
    const preservedProvider = {
      type: "openai",
      apiKeyEnv: "PRESERVED_API_KEY",
    };
    configPath = join(rootDir, "runtime.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ models: { providers: { preserved: preservedProvider } } }),
    );
    await service().save(connection);
    const orphanPath = originalModelPath();
    const orphanModel = JSON.parse(await readFile(orphanPath, "utf8"));
    const externalContent =
      JSON.stringify({ ...orphanModel, model: "external-owner-model" }, null, 2) +
      "\n";
    await writeFile(orphanPath, externalContent);
    const config = await source();
    config.models.profiles = {};
    const embedding = { provider: "ollama", model: "retained-embedding" };
    config.models.embeddingProfiles = { memory: embedding };
    config.plugins = { enabled: false };
    config.longTermMemory = { enabled: false, embeddingProfileId: "memory" };
    await writeFile(configPath, JSON.stringify(config));

    const reopened = service();
    expect((await reopened.status()).editableConnection).toBeUndefined();
    const recovered = await reopened.save({
      provider: "openai",
      model: "recovered-cloud",
      apiKey: "fixture-recovery-key",
      deferActivation: true,
    });
    expect(recovered.setup.status).toBe("ready");
    expect(recovered.setup.editableConnection?.revision).toEqual(
      expect.any(String),
    );
    expect(await readFile(orphanPath, "utf8")).toBe(externalContent);
    const updated = await source();
    expect(updated.models.providers.preserved).toEqual(preservedProvider);
    expect(updated.models.providers.ollama).toEqual(config.models.providers.ollama);
    expect(updated.models.embeddingProfiles).toEqual({ memory: embedding });
    expect(updated.plugins).toEqual(config.plugins);
    expect(updated.longTermMemory).toEqual(config.longTermMemory);
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default,
    ).toMatchObject({ provider: "openai", model: "recovered-cloud" });
  });

  test("failed recovery receipt creation rolls back only new files and permits a fresh retry", async () => {
    await service().save(connection);
    await removeProfiles();
    const before = await source();
    const modelPath = originalModelPath();
    const beforeModel = await readFile(modelPath, "utf8");
    const receiptPath = configPath! + ".web-setup.json";
    const beforeReceipt = await readFile(receiptPath, "utf8");
    const beforeFiles = (await readdir(dirname(modelPath))).sort();
    vi.spyOn(setupDraft, "createRuntimeSetupDraft").mockRejectedValueOnce(
      new Error("fixture-recovery-receipt-failed"),
    );

    await expect(
      service().save({ ...connection, model: "recovered-chat" }),
    ).rejects.toThrow("fixture-recovery-receipt-failed");
    expect(await source()).toEqual(before);
    expect(await readFile(modelPath, "utf8")).toBe(beforeModel);
    expect(await readFile(receiptPath, "utf8")).toBe(beforeReceipt);
    expect((await readdir(dirname(modelPath))).sort()).toEqual(beforeFiles);

    const retried = await service().save({
      ...connection,
      model: "recovered-chat",
    });
    expect(retried.setup.status).toBe("ready");
    expect(retried.setup.editableConnection?.revision).not.toBe(
      JSON.parse(beforeReceipt).revision,
    );
    expect(
      loadRuntimeConfig({ rootDir, configPath }).models?.profiles?.default.model,
    ).toBe("recovered-chat");
    expect(await readFile(modelPath, "utf8")).toBe(beforeModel);
    expect(await readdir(dirname(modelPath))).toHaveLength(beforeFiles.length + 1);
  });

  test("an occupied default model without an ownership receipt remains protected", async () => {
    configPath = join(rootDir, "runtime.config.json");
    const existing = {
      models: {
        providers: { ollama: { type: "ollama", baseUrl: connection.baseUrl } },
      },
    };
    const before = JSON.stringify(existing);
    await writeFile(configPath, before);
    const modelPath = originalModelPath();
    const beforeModel = '{"model":"reserved-external-model"}\\n';
    await mkdir(dirname(modelPath), { recursive: true });
    await writeFile(modelPath, beforeModel);

    await expect(service().save(connection)).rejects.toMatchObject({
      code: "setup_model_file_exists",
      statusCode: 409,
    });
    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await readFile(modelPath, "utf8")).toBe(beforeModel);
    expect(await readdir(dirname(modelPath))).toEqual(["default.config.json"]);
    await expect(readFile(configPath + ".web-setup.json", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(rootDir, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("an obsolete revision cannot authorize edits after profiles are removed", async () => {
    const initial = await service().save(connection);
    await removeProfiles();
    const before = await readFile(configPath!, "utf8");
    const beforeModel = await readFile(originalModelPath(), "utf8");
    const beforeReceipt = await readFile(configPath! + ".web-setup.json", "utf8");
    await expect(
      service().save({
        ...connection,
        model: "stale-tab",
        connectionRevision: initial.setup.editableConnection!.revision,
      }),
    ).rejects.toMatchObject({
      code: "setup_configuration_changed",
      statusCode: 409,
    });
    expect(await readFile(configPath!, "utf8")).toBe(before);
    expect(await readFile(originalModelPath(), "utf8")).toBe(beforeModel);
    expect(await readFile(configPath! + ".web-setup.json", "utf8")).toBe(
      beforeReceipt,
    );
  });

  test("a current draft still requires its revision for a changed connection", async () => {
    const initial = await service().save(connection);
    const before = await readFile(configPath!, "utf8");
    const beforeModel = await readFile(originalModelPath(), "utf8");
    await expect(
      service().save({ ...connection, model: "without-revision" }),
    ).rejects.toMatchObject({
      code: "setup_configuration_changed",
      statusCode: 409,
    });
    expect((await service().status()).editableConnection).toEqual(
      initial.setup.editableConnection,
    );
    expect(await readFile(configPath!, "utf8")).toBe(before);
    expect(await readFile(originalModelPath(), "utf8")).toBe(beforeModel);
  });
});
