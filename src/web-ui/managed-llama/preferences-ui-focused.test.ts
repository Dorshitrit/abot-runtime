import { expect, test, vi } from "vitest";
import { createManagedLlamaBinding, renderManagedLlama } from "../app/components/runtime-setup/managed-llama.js";
const saved = { modelPath: "/synthetic/saved.gguf", alias: "saved", port: 9090, contextTokens: 8192, gpuLayers: 12 };
const keys = Object.keys(saved);
function response(preferences: unknown = null, extra = {}) {
  return { ok: true, status: { supported: true, closed: false, phase: "idle", installation: "installed", ownsProcess: false, preferences, ...extra }, capabilities: null };
}
function setup(preferences: unknown = null, extra = {}) {
  const client = { getManagedLlamaStatus: vi.fn(async () => response(preferences, extra)), managedLlamaAction: vi.fn(async (_action: string) => response(saved)) };
  const onReady = vi.fn();
  const binding = createManagedLlamaBinding({ client, onReady });
  return { binding, client, onReady };
}
function values(binding: any) { return Object.fromEntries(keys.map(key => [key, binding.state[key]])); }
const expected = Object.fromEntries(Object.entries(saved).map(([key,value]) => [key,String(value)]));
test("initial cached preferences restore without automatic actions or readiness", async () => {
  const { binding, client, onReady } = setup(saved);
  renderManagedLlama(binding.state);
  expect(client.getManagedLlamaStatus).not.toHaveBeenCalled();
  expect(client.managedLlamaAction).not.toHaveBeenCalled();
  await binding.input("mode", "managed");
  expect(values(binding)).toEqual(expected);
  expect(client.getManagedLlamaStatus).toHaveBeenCalledTimes(1);
  expect(client.managedLlamaAction).not.toHaveBeenCalled();
  expect(binding.state.ready).toBeNull();
  expect(await binding.action("use")).toBe(false);
  expect(onReady).not.toHaveBeenCalled();
  expect(renderManagedLlama(binding.state)).toContain("explicit Start remains required");
});
test("explicit inspect restores pristine fields only and refresh never overwrites edits", async () => {
  const { binding, client } = setup();
  await binding.input("mode", "managed");
  binding.input("alias", "edited");
  await binding.action("inspect");
  expect(values(binding)).toEqual({ ...expected, alias: "edited" });
  for (const [field,value] of Object.entries({ modelPath: "/synthetic/edited.gguf", alias: "edited", port: "8081", contextTokens: "2048", gpuLayers: "0" })) binding.input(field,value);
  const edited = values(binding);
  client.getManagedLlamaStatus.mockResolvedValue(response(saved));
  await binding.action("refresh");
  await binding.action("inspect");
  expect(values(binding)).toEqual(edited);
  expect(client.managedLlamaAction.mock.calls.map(call => call[0])).toEqual(["inspect", "inspect"]);
  expect(binding.state.ready).toBeNull();
});
test("later cached refresh is not a new initial restoration", async () => {
  const { binding, client } = setup();
  await binding.input("mode", "managed");
  const initial = values(binding);
  client.getManagedLlamaStatus.mockResolvedValue(response(saved));
  await binding.action("refresh");
  expect(values(binding)).toEqual(initial);
  await binding.action("inspect");
  expect(values(binding)).toEqual(expected);
});
test.each([null, [], "bad", {}, { ...saved, apiKey: "synthetic-rejected-extra" }, { ...saved, ready: true }, { ...saved, alias: undefined }, { ...saved, modelPath: "relative.gguf" }, { ...saved, alias: "bad alias" }, { ...saved, port: "9090" }, { ...saved, port: 80 }, { ...saved, contextTokens: 511 }, { ...saved, gpuLayers: -1 }, { ...saved, gpuLayers: NaN }])("rejects malformed or extra-field snapshot %# without retaining it", async preferences => {
  const { binding, client } = setup(preferences);
  const initial = values(binding);
  await binding.input("mode", "managed");
  expect(values(binding)).toEqual(initial);
  expect(binding.state.status?.preferences).toBeNull();
  client.managedLlamaAction.mockResolvedValue(response(preferences));
  await binding.action("inspect");
  expect(values(binding)).toEqual(initial);
  expect(binding.state.status?.preferences).toBeNull();
  expect(JSON.stringify(binding.state)).not.toContain("synthetic-rejected-extra");
  expect(binding.state.ready).toBeNull();
});
test("reset clears pristine tracking and initial-cache tracking without actions", async () => {
  const { binding, client } = setup(saved);
  await binding.input("mode", "managed");
  binding.input("alias", "edited");
  binding.reset();
  expect(binding.state.mode).toBe("manual");
  expect(binding.state.alias).toBe("");
  expect(client.getManagedLlamaStatus).toHaveBeenCalledTimes(1);
  expect(client.managedLlamaAction).not.toHaveBeenCalled();
  await binding.input("mode", "managed");
  expect(values(binding)).toEqual(expected);
  expect(binding.state.ready).toBeNull();
});
test("persisted preferences with owned ready status do not authorize Use or automatic start", async () => {
  const { binding, client, onReady } = setup(saved, { phase: "ready", ownsProcess: true });
  await binding.input("mode", "managed");
  expect(values(binding)).toEqual(expected);
  expect(await binding.action("use")).toBe(false);
  expect(await binding.action("start")).toBe(false);
  expect(client.managedLlamaAction).not.toHaveBeenCalled();
  expect(onReady).not.toHaveBeenCalled();
  expect(renderManagedLlama(binding.state)).toContain("does not know its launch settings");
});
test("restored values become a ready snapshot only after explicit successful Start", async () => {
  const { binding, client, onReady } = setup(saved);
  await binding.input("mode", "managed");
  client.managedLlamaAction.mockResolvedValue(response(saved, { phase: "ready", ownsProcess: true }));
  expect(await binding.action("start")).toBe(true);
  expect(client.managedLlamaAction).toHaveBeenCalledExactlyOnceWith("start", saved, "");
  expect(onReady).not.toHaveBeenCalled();
  await binding.action("use");
  expect(onReady).toHaveBeenCalledExactlyOnceWith({ managedLlama: true, model: "saved", baseUrl: "http://127.0.0.1:9090", contextWindowTokens: 8192 });
});
