import * as setupCredentials from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";

const artifacts = resolve(
  ".codex/artifacts/pr71-recovery-guards-20260908/credential-completion",
);
const connection = {
  provider: "openai",
  model: "same-cloud-model",
  apiKey: "fixture-saved-key",
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

async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

async function snapshot() {
  return {
    config: await readFile(configPath!, "utf8"),
    model: await readFile(
      join(dirname(configPath!), "models/default.config.json"),
      "utf8",
    ),
    environment: await readOptional(join(rootDir, ".env")),
    receipt: await readOptional(configPath! + ".web-setup.json"),
    inheritedCredential: process.env.OPENAI_API_KEY,
  };
}

async function clearCredential() {
  vi.stubEnv("OPENAI_API_KEY", "");
  await writeFile(
    join(rootDir, ".env"),
    "LLM_RUNTIME_CONFIG_FILE=" + configPath + "\nOTHER=preserved\n",
  );
}

beforeEach(async () => {
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "case-"));
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

describe("revisionless missing-credential completion", () => {
  test.each([
    [true, "file"],
    [true, "inherited"],
    [false, "file"],
    [false, "inherited"],
  ] as const)(
    "cannot replace a configured key (draft: %s, credential source: %s)",
    async (deferActivation, credentialSource) => {
      await service().save({ ...connection, deferActivation });
      vi.stubEnv("OPENAI_API_KEY", "");
      if (credentialSource === "inherited") {
        await clearCredential();
        vi.stubEnv("OPENAI_API_KEY", "fixture-inherited-winner");
      }
      const before = await snapshot();
      await expect(
        service().save({ ...connection, apiKey: "fixture-stale-tab-key" }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await snapshot()).toEqual(before);
    },
  );

  test("a missing key does not permit an explicit context change without a revision", async () => {
    await service().save(connection);
    await clearCredential();
    const before = await snapshot();
    await expect(
      service().save({ ...connection, contextWindowTokens: 131072 }),
    ).rejects.toMatchObject({
      code: "setup_configuration_changed",
      statusCode: 409,
    });
    expect(await snapshot()).toEqual(before);
  });

  test.each(["address", "context"] as const)(
    "Ollama cannot bypass draft ownership when its %s changes",
    async (changedField) => {
      const local = {
        provider: "ollama",
        model: "same-local-model",
        baseUrl: "http://127.0.0.1:11434",
        contextWindowTokens: 32768,
        deferActivation: true,
      };
      await service().save(local);
      const before = await snapshot();
      const input =
        changedField === "address"
          ? { ...local, baseUrl: "http://changed-host:11434" }
          : { ...local, contextWindowTokens: 131072 };
      await expect(service().save(input)).rejects.toMatchObject({
        code: "setup_configuration_changed",
        statusCode: 409,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  test.each([
    [true, 131072],
    [false, undefined],
  ] as const)(
    "completes only the missing credential and keeps model settings (draft: %s, context: %s)",
    async (deferActivation, contextWindowTokens) => {
      await service().save({
        ...connection,
        deferActivation,
        contextWindowTokens: 131072,
      });
      await clearCredential();
      const before = await snapshot();
      expect((await service().status()).status).toBe("required");
      const completed = await service().save({
        ...connection,
        provider: " openai ",
        model: " same-cloud-model ",
        contextWindowTokens,
        apiKey: "fixture-completion-key",
      });
      expect(completed.setup.status).toBe("ready");
      expect(completed.setup.existingModel?.contextWindowTokens).toBe(131072);
      const after = await snapshot();
      expect(after.config).toBe(before.config);
      expect(after.model).toBe(before.model);
      expect(after.receipt).toBe(before.receipt);
      expect(after.environment).toContain("fixture-completion-key");
      expect(after.environment).toContain("OTHER=preserved");
    },
  );

  test("cannot silently ignore an existing custom OpenAI origin while filling its key", async () => {
    await service().save({ ...connection, deferActivation: false });
    await clearCredential();
    const config = JSON.parse(await readFile(configPath!, "utf8"));
    config.models.providers.openai.baseUrl =
      "https://custom-provider.example/v1";
    await writeFile(configPath!, JSON.stringify(config));
    const before = await snapshot();
    await expect(
      service().save({ ...connection, apiKey: "fixture-completion-key" }),
    ).rejects.toMatchObject({
      code: "setup_configuration_exists",
      statusCode: 409,
    });
    expect(await snapshot()).toEqual(before);
  });

  test("preserves a key that appears after completion eligibility was checked", async () => {
    await service().save(connection);
    await clearCredential();
    const before = await snapshot();
    const persist = setupCredentials.persistRuntimeSetupCredentials;
    const concurrentEnvironment =
      "OPENAI_API_KEY=fixture-concurrent-winner\nOTHER=concurrent\n";
    vi.spyOn(
      setupCredentials,
      "persistRuntimeSetupCredentials",
    ).mockImplementationOnce(async (params) => {
      await writeFile(join(rootDir, ".env"), concurrentEnvironment);
      return persist(params);
    });
    await expect(
      service().save({ ...connection, apiKey: "fixture-stale-tab-key" }),
    ).rejects.toMatchObject({
      code: "credential_already_configured",
      statusCode: 409,
    });
    const after = await snapshot();
    expect(after.environment).toBe(concurrentEnvironment);
    expect(after.config).toBe(before.config);
    expect(after.model).toBe(before.model);
    expect(after.receipt).toBe(before.receipt);
    expect(process.env.OPENAI_API_KEY).toBe("");
  });
});
