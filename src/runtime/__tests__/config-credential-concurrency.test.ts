import { parse } from "dotenv";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { persistRuntimeSetupCredentials } from "../../web-ui/local-runtime/runtime-setup-credentials.js";
import {
  prepareModelCredential,
  saveModelCredential,
} from "../../web-ui/local-runtime/model-setup-provider.js";

let rootDir: string;
let configPath: string;
beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr71-review-fixes-20260908/credentials",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  configPath = join(rootDir, "runtime.config.json");
  for (const key of ["CAS_FIRST_KEY", "CAS_SECOND_KEY", "CAS_EXISTING_KEY"])
    vi.stubEnv(key, "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

test("concurrent credential saves through root aliases retain distinct keys and unrelated assignments", async () => {
  await writeFile(join(rootDir, ".env"), 'UNCHANGED="fixture-value"\n');
  const alias = join(rootDir, "alias");
  await symlink(rootDir, alias);
  await Promise.all([
    persistRuntimeSetupCredentials({
      rootDir,
      configPath,
      apiKeyEnv: "CAS_FIRST_KEY",
      apiKey: "fixture-first",
    }),
    persistRuntimeSetupCredentials({
      rootDir: alias,
      configPath,
      apiKeyEnv: "CAS_SECOND_KEY",
      apiKey: "fixture-second",
    }),
  ]);
  expect(parse(await readFile(join(rootDir, ".env"), "utf8"))).toEqual({
    UNCHANGED: "fixture-value",
    LLM_RUNTIME_CONFIG_FILE: configPath,
    CAS_FIRST_KEY: "fixture-first",
    CAS_SECOND_KEY: "fixture-second",
  });
  expect((await stat(join(rootDir, ".env"))).mode & 0o777).toBe(0o600);
});

test("a model credential plan cannot replace a key saved after its initial check", async () => {
  const options = { rootDir, configPath };
  const plan = await prepareModelCredential(
    options,
    { type: "openai", apiKeyEnv: "CAS_EXISTING_KEY" },
    "fixture-stale-key",
  );
  await persistRuntimeSetupCredentials({
    ...options,
    apiKeyEnv: "CAS_EXISTING_KEY",
    apiKey: "fixture-current-key",
  });
  await expect(saveModelCredential(options, plan)).rejects.toMatchObject({
    code: "credential_already_configured",
    statusCode: 409,
  });
  expect(
    parse(await readFile(join(rootDir, ".env"), "utf8")).CAS_EXISTING_KEY,
  ).toBe("fixture-current-key");
  expect(process.env.CAS_EXISTING_KEY).toBe("fixture-current-key");
});

test("credential symlinks remain rejected inside the shared lock", async () => {
  const target = join(rootDir, "preserved");
  await writeFile(target, "preserve-me");
  await symlink(target, join(rootDir, ".env"));
  await expect(
    persistRuntimeSetupCredentials({
      rootDir,
      configPath,
      apiKeyEnv: "CAS_FIRST_KEY",
      apiKey: "fixture-key",
    }),
  ).rejects.toMatchObject({ code: "unsafe_credential_file" });
  expect(await readFile(target, "utf8")).toBe("preserve-me");
});
