import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../../config.js";
import type { RuntimeConfigOptions } from "../../config/types.js";

export async function createEnvironmentPathsFixture(environment?: unknown) {
  const rootDir = await mkdtemp(join(tmpdir(), "runtime-environment-paths-"));
  const configPath = join(rootDir, "runtime.config.json");
  const source = {
    modelGatewayUrl: "http://127.0.0.1:1",
    models: {
      defaults: { profileId: "test-model" },
      providers: { local: { type: "ollama" } },
      profiles: {
        "test-model": {
          provider: "local",
          model: "unused",
          contextWindowTokens: 32_768,
        },
      },
    },
    plugins: { enabled: false },
    logging: { enabled: false },
    requestRunner: { configRef: "./request-runner.json" },
    environment,
  };
  const save = () => writeFile(configPath, JSON.stringify(source));
  await writeFile(
    join(rootDir, "request-runner.json"),
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "test-model", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 5000 },
      steps: {},
    }),
  );
  await save();
  return {
    rootDir,
    source,
    save,
    load: (profileId?: string, env: RuntimeConfigOptions["env"] = {}) =>
      loadRuntimeConfig({ rootDir, configPath, profileId, env }),
    dispose: () => rm(rootDir, { recursive: true, force: true }),
  };
}
