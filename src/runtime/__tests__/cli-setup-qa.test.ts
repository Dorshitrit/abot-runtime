import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runInitRuntime } from "../../../scripts/init-runtime.js";
import { runAddRuntimeModel } from "../../../scripts/add-runtime-model.js";
import { requirePackagedSetupProvider } from "../../cli/setup-provider-validation.js";
import { warnOllamaSetupModel } from "../../cli/setup-model-warning.js";
import { runtimeStartupDiagnostic } from "../../cli/startup-diagnostic.js";

let rootDir: string;
beforeEach(async () => {
  const artifacts = resolve(".codex/artifacts/qa-210-20261029");
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "cli-setup-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

test("packaged setup rejects an unavailable adapter before creating files while source adapters remain extensible", async () => {
  await expect(runInitRuntime(["--root", rootDir, "--provider", "foo", "--model", "x"], { commandMode: "package" }))
    .rejects.toThrow("Unknown provider adapter 'foo'");
  await expect(readFile(join(rootDir, "local/runtime.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => requirePackagedSetupProvider("future-adapter", "source")).not.toThrow();
  expect(() => requirePackagedSetupProvider("ollama", "package")).not.toThrow();
});

test("CLI labels distinguish two profiles of one model and retain the original default", async () => {
  await runInitRuntime(["--root", rootDir, "--provider", "ollama", "--model", "qwen:3b", "--label", "Qwen SUPER"]);
  await runAddRuntimeModel(["--root", rootDir, "--provider", "ollama", "--model", "qwen:3b", "--profile", "qwen-ea", "--label=Qwen EA"]);
  const original = JSON.parse(await readFile(join(rootDir, "local/models/default.config.json"), "utf8"));
  const added = JSON.parse(await readFile(join(rootDir, "local/models/qwen-ea.config.json"), "utf8"));
  const runner = JSON.parse(await readFile(join(rootDir, "local/request-runner.config.json"), "utf8"));
  expect(original).toMatchObject({ model: "qwen:3b", label: "Qwen SUPER" });
  expect(added).toMatchObject({ model: "qwen:3b", label: "Qwen EA" });
  expect(runner.models.defaults.profileId).toBe("default");
});

test("invalid configured JSON and policy retain their diagnostic; only missing setup uses onboarding guidance", async () => {
  const configPath = join(rootDir, "runtime.json");
  expect(runtimeStartupDiagnostic(rootDir, configPath, new Error("missing"))).toContain("Complete model setup");
  await writeFile(configPath, "{broken");
  expect(runtimeStartupDiagnostic(rootDir, configPath, new Error("activation failed"))).toContain(`Invalid runtime config JSON at ${configPath}`);
  await writeFile(configPath, "{}");
  const policyError = new Error("Invalid runtime config: model profile.execution.policy must be one of: supervisor-worker-v1, execution-agent-v1");
  expect(runtimeStartupDiagnostic(rootDir, configPath, policyError)).toBe(policyError.message);
});

test("Ollama metadata warnings preserve offline setup and never invoke generation", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "installed:latest" }] })));
  await warnOllamaSetupModel({ commandMode: "package", provider: "ollama", model: "typo:1b", baseUrl: "http://fixture.invalid:11434" }, fetchImpl);
  expect(fetchImpl).toHaveBeenCalledWith("http://fixture.invalid:11434/api/tags", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not installed"));
  vi.mocked(console.warn).mockClear();
  fetchImpl.mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "installed:latest" }] })));
  await warnOllamaSetupModel({ commandMode: "package", provider: "ollama", model: "installed" }, fetchImpl);
  expect(console.warn).not.toHaveBeenCalled();
  fetchImpl.mockRejectedValue(new Error("offline"));
  await expect(warnOllamaSetupModel({ commandMode: "package", provider: "ollama", model: "future" }, fetchImpl)).resolves.toBeUndefined();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Configuration saved. Could not check"));
});

test("source and hosted-provider setup perform no metadata request", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await warnOllamaSetupModel({ commandMode: "source", provider: "ollama", model: "x" }, fetchImpl);
  await warnOllamaSetupModel({ commandMode: "package", provider: "openai", model: "x" }, fetchImpl);
  expect(fetchImpl).not.toHaveBeenCalled();
});
