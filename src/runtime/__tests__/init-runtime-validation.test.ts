import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadRuntimeConfig, RuntimeConfigValidationError } from "../config.js";
import type { ModelContextCapacityIssue } from "../config/model-context-capacity.js";
import { REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT } from "../config/runner/contracts.js";
import { createInitRuntimeValidationFixture } from "./support/init-runtime-validation-fixture.js";

type JsonObject = Record<string, unknown>;
const sourceRoot = resolve(import.meta.dirname, "../../..");
const fixtures = createInitRuntimeValidationFixture(join(sourceRoot, ".codex/artifacts/init-runtime-validation"));
const starterFiles = [
  ".env",
  "local/runtime.config.json",
  "local/request-runner.config.json",
  "local/models/default.config.json",
  "methodologies/response-ux.md",
  "methodologies/memory-informed-response.md",
];

function initialize(root: string, contextWindow = 32768, args: string[] = []) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("LLM_RUNTIME_")),
  );
  return spawnSync(process.execPath, [
    join(sourceRoot, "node_modules/tsx/dist/cli.mjs"),
    join(sourceRoot, "src/cli/bin.ts"),
    "init", "--provider", "ollama", "--model", "qa-mock",
    "--context-window", String(contextWindow), "--root", root, ...args,
  ], { cwd: sourceRoot, env: inherited, encoding: "utf-8", timeout: 20_000 });
}

function asRecord(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object in the setup fixture");
  return value as JsonObject;
}

async function readJson(root: string, file: string): Promise<JsonObject> {
  return JSON.parse(await readFile(join(root, file), "utf-8")) as JsonObject;
}

async function saveJson(root: string, file: string, value: JsonObject): Promise<void> {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshotFiles(root: string, files = starterFiles) {
  return Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf-8")]));
}

function contextCapacityIssue(root: string): ModelContextCapacityIssue {
  try {
    loadRuntimeConfig({
      rootDir: root,
      configPath: join(root, "local/runtime.config.json"),
      env: {},
    });
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigValidationError);
    const issue = (error as RuntimeConfigValidationError).capacityIssues[0];
    expect(issue).toBeDefined();
    return issue;
  }
  throw new Error("Expected canonical context-capacity validation to reject the fixture");
}

async function setModelContextWindow(root: string, tokens: number): Promise<void> {
  const file = "local/models/default.config.json";
  const model = await readJson(root, file);
  model.contextWindowTokens = tokens;
  await saveJson(root, file, model);
}

beforeAll(async () => {
  await fixtures.initializeSeed((root) => {
    const initialized = initialize(root);
    expect(initialized.status, initialized.stderr).toBe(0);
  });
}, 30_000);
afterEach(fixtures.cleanupConsumers);
afterAll(fixtures.cleanupSeed);

describe("abot init candidate validation", () => {
  it("rejects an invalid fresh setup and accepts a corrected retry in the same absolute path with spaces", async () => {
    const root = await fixtures.createConsumer();
    const rejected = initialize(root, 128);
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain("128");
    expect(rejected.stderr).toContain("reserves");
    expect(await readdir(root)).toEqual([]);

    const corrected = initialize(root);
    expect(corrected.status, corrected.stderr).toBe(0);
    expect((await readJson(root, "local/models/default.config.json")).contextWindowTokens).toBe(32768);
    expect(loadRuntimeConfig({
      rootDir: root,
      configPath: join(root, "local/runtime.config.json"),
      env: {},
    }).models?.profiles?.default.contextWindowTokens).toBe(32768);
  }, 60_000);

  it("preserves existing user edits byte for byte on an ordinary init", async () => {
    const root = await fixtures.createInitializedConsumer();
    const runtime = await readJson(root, "local/runtime.config.json");
    asRecord(asRecord(runtime.logging).rotation).maxFiles = 17;
    await saveJson(root, "local/runtime.config.json", runtime);
    const runner = await readJson(root, "local/request-runner.config.json");
    asRecord(runner.stepDefaults).timeoutMs = 98765;
    await saveJson(root, "local/request-runner.config.json", runner);
    const model = await readJson(root, "local/models/default.config.json");
    model.label = "User-maintained profile";
    await saveJson(root, "local/models/default.config.json", model);
    await writeFile(join(root, ".env"), "# User-owned configuration\nLLM_RUNTIME_CONFIG_FILE=local/runtime.config.json\nMY_SETTING=keep-me\n");
    await writeFile(join(root, "methodologies/response-ux.md"), "# User-authored response instructions\nPreserve these edits.\n");
    const before = await snapshotFiles(root);

    const result = initialize(root, 65536, ["--model", "replacement-must-not-be-used"]);
    expect(result.status, result.stderr).toBe(0);
    expect(await snapshotFiles(root)).toEqual(before);
  }, 60_000);

  it("diagnoses a legacy invalid profile with a precise non-destructive recovery path", async () => {
    const root = await fixtures.createInitializedConsumer();
    await setModelContextWindow(root, 128);
    const issue = contextCapacityIssue(root);
    const before = await snapshotFiles(root);

    const result = initialize(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(root, "local/models/default.config.json"));
    expect(result.stderr).toContain("contextWindowTokens");
    expect(result.stderr).toContain(String(issue.minimumTokens));
    expect(result.stderr).toMatch(/back.?up/i);
    expect(result.stderr).toMatch(/edit/i);
    expect(await snapshotFiles(root)).toEqual(before);

    await setModelContextWindow(root, 32768);
    const recovered = initialize(root);
    expect(recovered.status, recovered.stderr).toBe(0);
  }, 60_000);

  it("uses the calculated reserve boundary without hard-coding the starter budget", async () => {
    const fixture = await fixtures.createInitializedConsumer();
    await setModelContextWindow(fixture, 128);
    const issue = contextCapacityIssue(fixture);
    const root = await fixtures.createConsumer();

    const atReserve = initialize(root, issue.reservedTokens);
    expect(atReserve.status, atReserve.stderr).toBe(1);
    expect(await readdir(root)).toEqual([]);
    const aboveReserve = initialize(root, issue.minimumTokens);
    expect(aboveReserve.status, aboveReserve.stderr).toBe(0);
    expect((await readJson(root, "local/models/default.config.json")).contextWindowTokens).toBe(issue.minimumTokens);
  }, 60_000);

  it("validates an explicit force replacement before changing existing files", async () => {
    const root = await fixtures.createInitializedConsumer();
    const before = await snapshotFiles(root);
    const result = initialize(root, 128, ["--force"]);
    expect(result.status, result.stderr).toBe(1);
    expect(await snapshotFiles(root)).toEqual(before);
  }, 60_000);

  it("retains custom profile references, inline overrides, runner reserves and instruction paths during validation", async () => {
    const root = await fixtures.createInitializedConsumer();
    const runtime = await readJson(root, "local/runtime.config.json");
    const model = await readJson(root, "local/models/default.config.json");
    const runner = await readJson(root, "local/request-runner.config.json");
    await saveJson(root, "local/profiles/custom.json", model);
    asRecord(runtime.models).profiles = {
      default: { configRef: "./profiles/custom.json", contextWindowTokens: 50000 },
      alternate: { ...model, model: "another-user-model", contextWindowTokens: 60000 },
    };
    asRecord(runtime.requestRunner).configRef = "./runners/custom.json";
    runner.context = { outputReserveTokens: 20000, safetyReserveTokens: 14000, attachmentReserveTokens: 2048 };
    for (const step of ["supervisor.response", "execution.response"])
      asRecord(asRecord(runner.steps)[step]).instructionRefs = ["../instructions/response.md"];
    await mkdir(join(root, "local/instructions"), { recursive: true });
    await writeFile(join(root, "local/instructions/response.md"), "# Custom instructions\nKeep this source.\n");
    await saveJson(root, "local/runners/custom.json", runner);
    await saveJson(root, "local/runtime.config.json", runtime);
    const files = [...starterFiles, "local/profiles/custom.json", "local/runners/custom.json", "local/instructions/response.md"];
    const before = await snapshotFiles(root, files);

    const result = initialize(root);
    expect(result.status, result.stderr).toBe(0);
    expect(await snapshotFiles(root, files)).toEqual(before);
  }, 60_000);

  it("preserves distinct instruction-reference aliases when enforcing the canonical reference limit", async () => {
    const root = await fixtures.createConsumer();
    const runnerFile = "local/request-runner.config.json";
    const runner = await readJson(sourceRoot, "examples/request-runner.config.example.json");
    asRecord(asRecord(runner.steps)["supervisor.response"]).instructionRefs = Array.from(
      { length: REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT + 1 },
      (_, index) => `../${"./".repeat(index)}methodologies/response-ux.md`,
    );
    await saveJson(root, runnerFile, runner);
    const before = await readFile(join(root, runnerFile), "utf-8");

    const result = initialize(root);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("instructionRefs");
    expect(result.stderr).toContain(String(REQUEST_STEP_INSTRUCTION_REF_MAX_COUNT));
    expect(await readdir(root)).toEqual(["local"]);
    expect(await readdir(join(root, "local"))).toEqual(["request-runner.config.json"]);
    expect(await readFile(join(root, runnerFile), "utf-8")).toBe(before);
  }, 60_000);

  it("does not add starter files around an invalid pre-existing model in a partial installation", async () => {
    const fixture = await fixtures.createInitializedConsumer();
    const model = await readJson(fixture, "local/models/default.config.json");
    model.contextWindowTokens = 128;
    const root = await fixtures.createConsumer();
    await saveJson(root, "local/models/default.config.json", model);
    const before = await readFile(join(root, "local/models/default.config.json"), "utf-8");

    const result = initialize(root);
    expect(result.status, result.stderr).toBe(1);
    expect(await readdir(root)).toEqual(["local"]);
    expect(await readdir(join(root, "local"))).toEqual(["models"]);
    expect(await readFile(join(root, "local/models/default.config.json"), "utf-8")).toBe(before);
  }, 60_000);
});
