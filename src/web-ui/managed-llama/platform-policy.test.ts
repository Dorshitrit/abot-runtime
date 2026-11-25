import { afterEach, expect, test, vi } from "vitest";
import { selectRelease, SUPPORTED_PLATFORMS } from "./release.js";
import { isLocalModelPath } from "./host-files.js";
import { llamaProcessEnvironment } from "./process-environment.js";
import { validateLaunch } from "./launch.js";
import { ManagedLlamaService } from "./service.js";
import { createManagedLlamaBinding } from "../app/components/runtime-setup/managed-llama.js";
afterEach(() => vi.unstubAllGlobals());

test.each(["linux", "win32"])("selects a pinned x64 CPU release and advertises it without IO: %s", os => {
  const release = selectRelease({ os, arch: "x64" });
  expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(release.size).toBeGreaterThan(20_000_000);
  expect(release.name).toContain(os === "win32" ? "win-cpu-x64.zip" : "ubuntu-x64.tar.gz");
  const service = new ManagedLlamaService("/never-accessed", { platform: { os, arch: "x64" } });
  expect(service.capabilities()).toMatchObject({ supported: true, cpuOnly: true, supportedPlatforms: [...SUPPORTED_PLATFORMS] });
  expect(service.status().installation).toBe("unknown");
  expect(() => selectRelease({ os, arch: "arm64" })).toThrow();
});
test.each(["C:\\Models\\מודל.gguf", "D:/models with spaces/model.gguf"])("accepts a local Windows model path: %s", path => {
  expect(isLocalModelPath(path, "win32")).toBe(true);
});
test.each(["C:relative.gguf", "\\\\server\\share\\model.gguf", "\\\\?\\C:\\model.gguf", "C:\\CON.gguf", "C:\\model.gguf:stream", "C:\\..\\model.gguf", "C:\\dir.\\model.gguf"])("rejects ambiguous Windows paths: %s", path => {
  expect(isLocalModelPath(path, "win32")).toBe(false);
});
test("Windows child environment retains required system location and only the explicit credential", () => {
  const source = { SystemRoot: "D:\\Windows", OPENAI_API_KEY: "foreign", NODE_OPTIONS: "hook", LLAMA_ARG_MODEL: "foreign", Path: "untrusted" };
  expect(llamaProcessEnvironment("managed", "win32", source)).toEqual({ SystemRoot: "D:\\Windows", PATH: "D:\\Windows\\System32", LLAMA_API_KEY: "managed" });
  expect(llamaProcessEnvironment("managed", "linux", source)).toEqual({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", LLAMA_API_KEY: "managed" });
  expect(source.LLAMA_ARG_MODEL).toBe("foreign");
});
test.each(["linux", "win32"])("CPU host rejects GPU settings before filesystem access: %s", async os => {
  vi.stubGlobal("process", { ...process, platform: os });
  await expect(validateLaunch({ modelPath: os === "win32" ? "C:\\model.gguf" : "/model.gguf", alias: "unit", port: 8080, contextTokens: 4096, gpuLayers: 1 })).rejects.toMatchObject({ code: "invalid_launch" });
});
test("the shared wizard submits and restores Windows paths on a CPU host", async () => {
  const modelPath = "C:\\models with spaces\\מודל.gguf";
  const preferences = { modelPath, alias: "unit", port: 8080, contextTokens: 4096, gpuLayers: 0 };
  const client = {
    getManagedLlamaStatus: vi.fn(async () => ({ ok: true, capabilities: { cpuOnly: true }, status: { supported: true, phase: "idle", installation: "installed", preferences } })),
    managedLlamaAction: vi.fn(async () => ({ ok: true, status: { supported: true, phase: "ready", ownsProcess: true } })),
  };
  const binding = createManagedLlamaBinding({ client });
  await binding.input("mode", "managed");
  expect(binding.state.modelPath).toBe(modelPath);
  expect(await binding.action("start")).toBe(true);
  expect(client.managedLlamaAction).toHaveBeenCalledWith("start", preferences, "");
});
