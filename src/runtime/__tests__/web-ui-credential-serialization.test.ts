import { parse } from "dotenv";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  persistRuntimeSetupCredentials,
  readRuntimeSetupCredential,
} from "../../web-ui/local-runtime/runtime-setup-credentials.js";

const apiKeyEnv = "SERIALIZATION_FIXTURE_KEY";
let rootDir: string;
beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr71-fourth-review-20260908/credentials",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  vi.stubEnv(apiKeyEnv, undefined);
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", undefined);
  vi.stubEnv("UNRELATED", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(rootDir, { recursive: true, force: true });
});

test.each([
  ["Windows directories", String.raw`C:\repo\new\runtime.config.json`],
  [
    "Windows spaces and hash",
    String.raw`C:\new project #1\repo\runtime.config.json`,
  ],
  ["Windows apostrophe", String.raw`C:\O'Brien\repo\runtime.config.json`],
  ["POSIX quotes and hash", "/tmp/O'Brien #1/runtime.config.json"],
  ["POSIX double quote", '/tmp/a"b #1/runtime.config.json'],
  ["Unicode", "C:\\משתמשים\\new\\runtime.config.json"],
])(
  "round-trips %s through dotenv and the process startup loader",
  async (_, configPath) => {
    const apiKey = String.raw`fixture-\new-\raw-#key`;
    await writeFile(join(rootDir, ".env"), 'UNRELATED="preserved"\n');
    await persistRuntimeSetupCredentials({
      rootDir,
      configPath,
      apiKeyEnv,
      apiKey,
    });
    const saved = await readFile(join(rootDir, ".env"), "utf8");
    expect(parse(saved)).toEqual({
      UNRELATED: "preserved",
      LLM_RUNTIME_CONFIG_FILE: configPath,
      [apiKeyEnv]: apiKey,
    });
    vi.stubEnv(apiKeyEnv, undefined);
    expect(readRuntimeSetupCredential(rootDir, apiKeyEnv)).toBe(apiKey);

    vi.resetModules();
    const { loadDotEnvFile } = await import("../../shared/load-dotenv.js");
    loadDotEnvFile(join(rootDir, ".env"));
    expect(process.env.LLM_RUNTIME_CONFIG_FILE).toBe(configPath);
    expect(process.env[apiKeyEnv]).toBe(apiKey);
  },
);

test("replacing a serialized assignment removes the previous value and preserves neighbors", async () => {
  const first = String.raw`C:\repo\new\first.json`;
  const second = String.raw`C:\repo\next\second.json`;
  await writeFile(join(rootDir, ".env"), "NEIGHBOR=unchanged\n");
  await persistRuntimeSetupCredentials({
    rootDir,
    configPath: first,
    apiKeyEnv,
    apiKey: String.raw`fixture-\raw-first`,
  });
  await persistRuntimeSetupCredentials({
    rootDir,
    configPath: second,
    apiKeyEnv,
    apiKey: String.raw`fixture-\new-second`,
  });
  const saved = await readFile(join(rootDir, ".env"), "utf8");
  expect(parse(saved)).toEqual({
    NEIGHBOR: "unchanged",
    LLM_RUNTIME_CONFIG_FILE: second,
    [apiKeyEnv]: String.raw`fixture-\new-second`,
  });
  expect(saved.match(/LLM_RUNTIME_CONFIG_FILE=/gu)).toHaveLength(1);
  expect(saved.match(/SERIALIZATION_FIXTURE_KEY=/gu)).toHaveLength(1);
});

test.each([
  "a\nINJECTED=value",
  "a\rINJECTED=value",
  String.raw`C:\O'Brien #1\new\runtime.config.json`,
])(
  "rejects an unrepresentable value before changing credentials",
  async (configPath) => {
    const original =
      'LLM_RUNTIME_CONFIG_FILE="preserved.json"\nNEIGHBOR=unchanged\n';
    await writeFile(join(rootDir, ".env"), original);
    await expect(
      persistRuntimeSetupCredentials({
        rootDir,
        configPath,
        apiKeyEnv,
        apiKey: "fixture-safe",
      }),
    ).rejects.toMatchObject({ code: "unsupported_setup_environment_value" });
    expect(await readFile(join(rootDir, ".env"), "utf8")).toBe(original);
    expect(process.env[apiKeyEnv]).toBeUndefined();
  },
);
