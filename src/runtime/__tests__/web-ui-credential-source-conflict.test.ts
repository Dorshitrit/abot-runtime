import { parse } from "dotenv";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { persistRuntimeSetupCredentials } from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import {
  prepareModelCredential,
  saveModelCredential,
} from "../../web-ui/local-runtime/model-setup-provider.js";

const apiKeyEnv = "CREDENTIAL_SOURCE_FIXTURE_KEY";
let rootDir: string;
let configPath: string;
const original = 'LLM_RUNTIME_CONFIG_FILE="original.json"\nUNCHANGED=value\n';

beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr71-fifth-review-20260908/credentials",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  configPath = join(rootDir, "runtime.config.json");
  vi.stubEnv(apiKeyEnv, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

async function seedCredentials(
  fileKey: string | undefined,
  inheritedKey: string | undefined,
) {
  const content = original + (fileKey ? `${apiKeyEnv}="${fileKey}"\n` : "");
  await writeFile(join(rootDir, ".env"), content);
  vi.stubEnv(apiKeyEnv, inheritedKey);
  return content;
}

test.each(["fixture-inherited", "fixture-file", "fixture-third"])(
  "rejects %s when configured credential sources disagree",
  async (apiKey) => {
    const content = await seedCredentials("fixture-file", "fixture-inherited");
    await expect(
      persistRuntimeSetupCredentials({
        rootDir,
        configPath,
        apiKeyEnv,
        apiKey,
        preserveExistingCredential: true,
      }),
    ).rejects.toMatchObject({
      code: "credential_already_configured",
      statusCode: 409,
    });
    expect(await readFile(join(rootDir, ".env"), "utf8")).toBe(content);
    expect(process.env[apiKeyEnv]).toBe("fixture-inherited");
    expect(await readdir(rootDir)).toEqual([".env"]);
  },
);

test.each([
  { label: "missing binding", fileKey: undefined, inheritedKey: undefined },
  { label: "file binding", fileKey: "fixture-same", inheritedKey: undefined },
  {
    label: "inherited binding",
    fileKey: undefined,
    inheritedKey: "fixture-same",
  },
  {
    label: "both bindings",
    fileKey: "fixture-same",
    inheritedKey: "fixture-same",
  },
])("fills or reuses an unchanged $label", async ({ fileKey, inheritedKey }) => {
  await seedCredentials(fileKey, inheritedKey);
  await persistRuntimeSetupCredentials({
    rootDir,
    configPath,
    apiKeyEnv,
    apiKey: "fixture-same",
    preserveExistingCredential: true,
  });
  expect(parse(await readFile(join(rootDir, ".env"), "utf8"))).toEqual({
    LLM_RUNTIME_CONFIG_FILE: configPath,
    UNCHANGED: "value",
    [apiKeyEnv]: "fixture-same",
  });
  expect(process.env[apiKeyEnv]).toBe("fixture-same");
});

test("an omitted key preserves divergent credentials while updating only the config pointer", async () => {
  await seedCredentials("fixture-file", "fixture-inherited");
  await persistRuntimeSetupCredentials({
    rootDir,
    configPath,
    apiKeyEnv,
    preserveExistingCredential: true,
  });
  expect(parse(await readFile(join(rootDir, ".env"), "utf8"))).toEqual({
    LLM_RUNTIME_CONFIG_FILE: configPath,
    UNCHANGED: "value",
    [apiKeyEnv]: "fixture-file",
  });
  expect(process.env[apiKeyEnv]).toBe("fixture-inherited");
});

test("a model credential plan cannot overwrite a later external file edit hidden by the process key", async () => {
  await seedCredentials(undefined, undefined);
  const options = { rootDir, configPath };
  const plan = await prepareModelCredential(
    options,
    { type: "openai", apiKeyEnv },
    "fixture-planned",
  );
  const external = await seedCredentials("fixture-external", "fixture-planned");
  await expect(saveModelCredential(options, plan)).rejects.toMatchObject({
    code: "credential_already_configured",
    statusCode: 409,
  });
  expect(await readFile(join(rootDir, ".env"), "utf8")).toBe(external);
  expect(process.env[apiKeyEnv]).toBe("fixture-planned");
});
