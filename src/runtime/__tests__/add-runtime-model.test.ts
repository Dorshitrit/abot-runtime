import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../../..");
const initScript = join(rootDir, "scripts", "init-runtime.ts");
const addModelScript = join(rootDir, "scripts", "add-runtime-model.ts");
const tsxCli = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const temporaryRoots: string[] = [];

async function createTargetRoot(): Promise<string> {
  const targetRoot = await mkdtemp(join(tmpdir(), "abot-add-model-"));
  temporaryRoots.push(targetRoot);
  return targetRoot;
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: rootDir,
    encoding: "utf-8",
  });
}

function runInit(targetRoot: string, baseUrl?: string) {
  return runScript(initScript, [
    "--provider",
    "ollama",
    "--model",
    "local-model",
    ...(baseUrl ? ["--base-url", baseUrl] : []),
    "--root",
    targetRoot,
  ]);
}

function runAdd(targetRoot: string, args: string[]) {
  return runScript(addModelScript, [...args, "--root", targetRoot]);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("add-runtime-model", () => {
  it("adds an OpenAI provider and profile without changing the existing default", async () => {
    const targetRoot = await createTargetRoot();
    const initialized = runInit(targetRoot);
    expect(initialized.status, initialized.stderr).toBe(0);
    const existingModelPath = join(
      targetRoot,
      "local",
      "models",
      "default.config.json",
    );
    const existingModel = await readFile(existingModelPath, "utf-8");

    const added = runAdd(targetRoot, [
      "--profile",
      "luna",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-luna",
    ]);

    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain("provider: openai (added)");
    expect(added.stdout).toContain("default profile: unchanged");
    const runtime = await readJson(
      join(targetRoot, "local", "runtime.config.json"),
    );
    const models = asRecord(runtime.models);
    expect(asRecord(models.providers)).toEqual({
      ollama: { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
      openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" },
    });
    expect(asRecord(models.profiles)).toEqual({
      default: { configRef: "./models/default.config.json" },
      luna: { configRef: "./models/luna.config.json" },
    });
    expect(await readFile(existingModelPath, "utf-8")).toBe(existingModel);

    const runner = await readJson(
      join(targetRoot, "local", "request-runner.config.json"),
    );
    expect(asRecord(asRecord(runner.models).defaults).profileId).toBe(
      "default",
    );
    const luna = await readJson(
      join(targetRoot, "local", "models", "luna.config.json"),
    );
    expect(luna).toMatchObject({
      label: "gpt-5.6-luna",
      provider: "openai",
      model: "gpt-5.6-luna",
      execution: { policy: "execution-agent-v1" },
      context: { formatTokenAccounting: { mode: "estimate" } },
    });
  });

  it("changes only the selected default when --default is explicit", async () => {
    const targetRoot = await createTargetRoot();
    expect(runInit(targetRoot).status).toBe(0);

    const added = runAdd(targetRoot, [
      "--profile",
      "luna",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-luna",
      "--default",
    ]);

    expect(added.status, added.stderr).toBe(0);
    const runner = await readJson(
      join(targetRoot, "local", "request-runner.config.json"),
    );
    expect(asRecord(asRecord(runner.models).defaults).profileId).toBe("luna");
    const runtime = await readJson(
      join(targetRoot, "local", "runtime.config.json"),
    );
    expect(Object.keys(asRecord(asRecord(runtime.models).profiles))).toEqual([
      "default",
      "luna",
    ]);
  });

  it("fails closed on a profile collision without changing any config", async () => {
    const targetRoot = await createTargetRoot();
    expect(runInit(targetRoot).status).toBe(0);
    expect(
      runAdd(targetRoot, [
        "--profile",
        "luna",
        "--provider",
        "openai",
        "--model",
        "gpt-5.6-luna",
      ]).status,
    ).toBe(0);
    const paths = [
      join(targetRoot, "local", "runtime.config.json"),
      join(targetRoot, "local", "request-runner.config.json"),
      join(targetRoot, "local", "models", "default.config.json"),
      join(targetRoot, "local", "models", "luna.config.json"),
    ];
    const before = await Promise.all(
      paths.map((path) => readFile(path, "utf-8")),
    );

    const collision = runAdd(targetRoot, [
      "--profile",
      "luna",
      "--provider",
      "openai",
      "--model",
      "another-model",
      "--default",
    ]);

    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain("no files were changed");
    await expect(
      Promise.all(paths.map((path) => readFile(path, "utf-8"))),
    ).resolves.toEqual(before);
  });

  it("reuses an existing provider without replacing its configuration", async () => {
    const targetRoot = await createTargetRoot();
    expect(
      runInit(targetRoot, "http://host.docker.internal:11434").status,
    ).toBe(0);

    const added = runAdd(targetRoot, [
      "--profile",
      "second-local",
      "--provider",
      "ollama",
      "--model",
      "another-local-model",
    ]);

    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain("provider: ollama (kept)");
    const runtime = await readJson(
      join(targetRoot, "local", "runtime.config.json"),
    );
    expect(asRecord(asRecord(runtime.models).providers)).toEqual({
      ollama: {
        type: "ollama",
        baseUrl: "http://host.docker.internal:11434",
      },
    });
  });
});
