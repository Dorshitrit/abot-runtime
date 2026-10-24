import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const exec = promisify(execFile);
let directory: string;
const rootDir = process.cwd();
const cli = join(rootDir, "node_modules/tsx/dist/cli.mjs");
const run = (script: string, args: string[]) => exec(process.execPath, [
  cli, join(rootDir, "scripts", script), ...args, "--root", directory,
], { cwd: rootDir, env: { ...process.env, LLM_RUNTIME_CONFIG_FILE: "" } });
const json = async (path: string) => JSON.parse(await readFile(join(directory, path), "utf8"));
beforeEach(async () => {
  const artifacts = resolve(".codex/artifacts/llamacpp-setup-20261019");
  await mkdir(artifacts, { recursive: true });
  directory = await mkdtemp(join(artifacts, "cli-"));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("llama.cpp CLI setup", () => {
  test.each([0, 512])("initializes an endpoint, optional env binding and per-model budget %s", async (tokens) => {
    await run("init-runtime.ts", [
      "--provider", "llamacpp", "--model", "gemma", "--base-url", "http://model-host:8080",
      "--context-window", "32768", "--supports-thinking", "true", "--reasoning-budget", String(tokens),
      "--api-key-env", "MY_LLAMA_KEY",
    ]);
    expect((await json("local/runtime.config.json")).models.providers.llamacpp)
      .toEqual({ type: "llamacpp", baseUrl: "http://model-host:8080", apiKeyEnv: "MY_LLAMA_KEY" });
    expect(await json("local/models/default.config.json")).toMatchObject({
      provider: "llamacpp", model: "gemma", supportsThinking: true, contextWindowTokens: 32768,
      generation: { reasoningBudget: { mode: "tokens", tokens } },
      capabilities: { inputModalities: ["text"] },
    });
  });
  test("adds a llama model non-destructively and rejects conflicting endpoint reuse", async () => {
    await run("init-runtime.ts", ["--provider", "ollama", "--model", "previous"]);
    const before = await json("local/request-runner.config.json");
    await run("add-runtime-model.ts", [
      "--provider", "llamacpp", "--model", "gemma", "--profile", "gemma",
      "--base-url", "http://llama-host:8080", "--supports-thinking", "true", "--reasoning-budget", "server-default",
    ]);
    const config = await json("local/runtime.config.json");
    expect(config.models.providers.ollama.type).toBe("ollama");
    expect(config.models.profiles.default).toBeDefined();
    expect(await json("local/request-runner.config.json")).toEqual(before);
    expect((await json("local/models/gemma.config.json")).generation.reasoningBudget).toEqual({ mode: "server-default" });
    await expect(run("add-runtime-model.ts", [
      "--provider", "llamacpp", "--model", "gemma", "--profile", "conflict",
      "--base-url", "http://other-host:8080",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("different base URL") });
  });
  test.each(["", "   ", "\t"])("rejects blank budget %j before creating files", async (value) => {
    await expect(run("init-runtime.ts", [
      "--provider", "llamacpp", "--model", "gemma", "--supports-thinking", "true", "--reasoning-budget", value,
    ])).rejects.toMatchObject({ stderr: expect.stringMatching(/requires a value|A reasoning budget is required/) });
    await expect(readFile(join(directory, "local/runtime.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("rejects invalid reasoning flags before creating files", async () => {
    await expect(run("init-runtime.ts", [
      "--provider", "llamacpp", "--model", "gemma", "--reasoning-budget", "512",
    ])).rejects.toMatchObject({ stderr: expect.stringContaining("Enable reasoning support") });
    await expect(readFile(join(directory, "local/runtime.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
