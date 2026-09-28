import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { vi } from "vitest";
import { RuntimeSetupService } from "../../../web-ui/local-runtime/runtime-setup-service.js";
import { ModelSetupService } from "../../../web-ui/local-runtime/model-setup-service.js";

export async function createModelSetupFixture(artifactDirectory?: string) {
  const artifacts = resolve(
    artifactDirectory ??
      ".codex/artifacts/onboarding-plugins-1.4-20260908/model-add-wizard",
  );
  await mkdir(artifacts, { recursive: true });
  const rootDir = await mkdtemp(join(artifacts, "fixture-"));
  const inheritedKeys = new Set(Object.keys(process.env));
  for (const name of [
    "LLM_RUNTIME_CONFIG_FILE",
    "OPENAI_API_KEY",
    "MODEL_FIXTURE_KEY",
  ])
    vi.stubEnv(name, "");
  let configPath = "";
  const setup = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => configPath || undefined,
    configure: (path) => {
      configPath = path;
    },
    activate: async () => ({ status: "ready" }),
  });
  await setup.save({
    provider: "ollama",
    model: "fixture-chat",
    deferActivation: true,
  });
  const service = new ModelSetupService({
    rootDir,
    getConfigPath: () => configPath,
  });
  const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
  const writeConfig = async (config: Record<string, unknown>) =>
    writeFile(configPath, JSON.stringify(config));
  async function readModelProfile(profileId: string) {
    const declaration = (await readConfig()).models.profiles[profileId];
    if (!declaration.configRef) return declaration;
    return JSON.parse(
      await readFile(
        resolve(dirname(configPath), declaration.configRef),
        "utf8",
      ),
    );
  }
  async function writeModelProfile(
    profileId: string,
    profile: Record<string, unknown>,
  ) {
    const config = await readConfig();
    const declaration = config.models.profiles[profileId];
    if (declaration.configRef) {
      await writeFile(
        resolve(dirname(configPath), declaration.configRef),
        JSON.stringify(profile),
      );
      return;
    }
    config.models.profiles[profileId] = profile;
    await writeConfig(config);
  }
  const envPath = join(rootDir, ".env");
  const readEnv = () => readFile(envPath, "utf8");
  return {
    rootDir,
    configPath,
    envPath,
    service,
    readConfig,
    writeConfig,
    readModelProfile,
    writeModelProfile,
    readEnv,
    async cleanup() {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const name of Object.keys(process.env))
        if (name.startsWith("ABOT_MODEL_PROVIDER_") && !inheritedKeys.has(name))
          delete process.env[name];
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export type ModelSetupFixture = Awaited<
  ReturnType<typeof createModelSetupFixture>
>;
