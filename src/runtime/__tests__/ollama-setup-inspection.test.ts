import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inspectModelSetupConnection } from "../../web-ui/local-runtime/model-connection-inspection.js";

let rootDir: string;
let configPath: string;
const fetchImpl = vi.fn<typeof fetch>();
beforeEach(async () => {
  const artifacts = resolve(".codex/artifacts/pr323-review-fixes");
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "ollama-inspect-"));
  configPath = join(rootDir, "runtime.config.json");
  await writeFile(configPath, JSON.stringify({ models: { providers: {
    local: { type: "ollama", baseUrl: "http://saved.invalid:11434" },
  } } }));
  fetchImpl.mockReset().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen:3b" }, { name: "qwen:3b" }, { name: "nomic:latest" }] })));
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubEnv("OLLAMA_URL", "");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

test("saved Ollama discovery uses the saved origin and returns unique installed IDs without credentials", async () => {
  vi.stubEnv("OLLAMA_URL", "http://fallback.invalid:11435");
  const result = await inspectModelSetupConnection({ rootDir, configPath }, { providerId: "local", baseUrl: "http://override.invalid" }, new AbortController().signal);
  expect(result).toEqual({ models: ["qwen:3b", "nomic:latest"] });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledWith("http://saved.invalid:11434/api/tags", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(fetchImpl.mock.calls[0]?.[1]).not.toHaveProperty("headers");
});

test.each([
  { fallback: "", expected: "http://127.0.0.1:11434" },
  { fallback: "http://fallback.invalid:11435/", expected: "http://fallback.invalid:11435" },
])("saved Ollama without baseUrl uses the invocation fallback $expected", async ({ fallback, expected }) => {
  await writeFile(configPath, JSON.stringify({ models: { providers: {
    local: { type: "ollama" },
  } } }));
  vi.stubEnv("OLLAMA_URL", fallback);
  const result = await inspectModelSetupConnection(
    { rootDir, configPath }, { providerId: "local", baseUrl: "http://untrusted-override.invalid" },
    new AbortController().signal,
  );
  expect(result).toEqual({ models: ["qwen:3b", "nomic:latest"] });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    `${expected}/api/tags`, expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test("saved Ollama discovery retains a configured origin and normalizes trailing slashes", async () => {
  await writeFile(configPath, JSON.stringify({ models: { providers: {
    local: { type: "ollama", baseUrl: "http://configured.invalid:11435/" },
  } } }));
  vi.stubEnv("OLLAMA_URL", "http://fallback.invalid:11435");
  await inspectModelSetupConnection({ rootDir, configPath }, { providerId: "local" }, new AbortController().signal);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    "http://configured.invalid:11435/api/tags", expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

test.each([
  "http://provider.invalid/ollama",
  "http://user:secret@provider.invalid:11434",
  "file:///private/ollama",
])("saved Ollama discovery rejects unsafe effective address %s before fetching", async (baseUrl) => {
  await writeFile(configPath, JSON.stringify({ models: { providers: {
    local: { type: "ollama", baseUrl },
  } } }));
  await expect(inspectModelSetupConnection({ rootDir, configPath }, { providerId: "local" }, new AbortController().signal))
    .rejects.toMatchObject({ code: "invalid_connection_address" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("new Ollama discovery checks metadata at the requested origin", async () => {
  await inspectModelSetupConnection({ rootDir, configPath }, { provider: "ollama", baseUrl: "http://new.invalid:11434" }, new AbortController().signal);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://new.invalid:11434/api/tags");
});

test("new Ollama and saved llama.cpp connections still require an explicit valid address", async () => {
  await writeFile(configPath, JSON.stringify({ models: { providers: {
    llama: { type: "llamacpp" },
    invalid: { type: "ollama", baseUrl: 11434 },
  } } }));
  vi.stubEnv("OLLAMA_URL", "http://fallback.invalid:11435");
  for (const body of [{ provider: "ollama" }, { providerId: "llama" }, { providerId: "invalid" }]) {
    await expect(inspectModelSetupConnection({ rootDir, configPath }, body, new AbortController().signal))
      .rejects.toMatchObject({ code: "invalid_connection_address" });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("unavailable Ollama returns a safe actionable error and unsupported providers make no request", async () => {
  fetchImpl.mockRejectedValue(new Error("private-network-detail"));
  await expect(inspectModelSetupConnection({ rootDir, configPath }, { providerId: "local" }, new AbortController().signal))
    .rejects.toMatchObject({ code: "model_connection_unavailable", statusCode: 502, message: expect.stringContaining("whether Ollama is running") });
  fetchImpl.mockClear();
  await expect(inspectModelSetupConnection({ rootDir, configPath }, { provider: "openai" }, new AbortController().signal))
    .rejects.toMatchObject({ code: "unsupported_connection_inspection" });
  expect(fetchImpl).not.toHaveBeenCalled();
});
