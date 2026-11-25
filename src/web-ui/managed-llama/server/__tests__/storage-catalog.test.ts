import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateRoot, serverSettings, ggufBytes, writeGguf } from "./fixtures.js";
import { ServerStateStore } from "../state-store.js";
import { parseServerSettings } from "../settings.js";
import { inspectGguf } from "../gguf-metadata.js";
import { inspectTemplate, validateServerModels } from "../model-validation.js";
import { discoverOllamaModels, inspectModelCandidate } from "../catalog.js";
import { createServerPresets, embeddingArguments } from "../presets.js";

const roots: string[] = [];
async function setup() { const root = await privateRoot(); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("settings round-trip across store instances, retain credentials and reject stale saves", async () => {
  const root = await setup(), settings = serverSettings(root), store = new ServerStateStore(root);
  expect(await store.read()).toBeNull();
  const first = await store.save(settings, null);
  const reopened = new ServerStateStore(root);
  expect(await reopened.read()).toEqual(first);
  const next = await reopened.save({ ...settings, startup: "with-abot", sleepIdleSeconds: -1 }, first.revision);
  expect(next.apiKey).toBe(first.apiKey); expect(next.revision).not.toBe(first.revision);
  await expect(store.save(settings, first.revision)).rejects.toMatchObject({ code: "server_settings_changed" });
  expect(await store.read()).toEqual(next);
  expect(await readdir(root)).toEqual(["server-state.json"]);
});
test("legacy preferences never create a server configuration; corrupt state and held lock fail closed", async () => {
  const root = await setup(), store = new ServerStateStore(root), settings = serverSettings(root);
  await writeFile(join(root, "launch-state.json"), JSON.stringify(settings));
  expect(await store.read()).toBeNull();
  await writeFile(join(root, "server-state.lock"), "");
  await expect(store.save(settings, null)).rejects.toMatchObject({ code: "server_state_busy" });
  await rm(join(root, "server-state.lock"));
  await store.save(settings, null);
  const path = join(root, "server-state.json"), text = await readFile(path, "utf8");
  await writeFile(path, text.replace('"schema":1', '"schema":1,"schema":1'));
  await expect(store.read()).rejects.toMatchObject({ code: "server_state_unavailable" });
});
test.each([0, -2, 86401])("invalid idle timing %s is rejected", async value => {
  const settings = serverSettings(await setup());
  expect(() => parseServerSettings({ ...settings, sleepIdleSeconds: value })).toThrow();
});
test("ambiguous aliases, colliding ports and preset injection are rejected", async () => {
  const settings = serverSettings(await setup()), model = settings.models[0]!;
  expect(() => parseServerSettings({ ...settings, models: [model, model] })).toThrow();
  expect(() => parseServerSettings({ ...settings, models: [{ ...model, modelPath: model.modelPath + "\nport=9999" }] })).toThrow();
  expect(() => parseServerSettings({ ...settings, embedding: { ...model, alias: "embed", port: settings.port, pooling: "mean", batchTokens: 512 } })).toThrow();
});
test("bounded GGUF metadata distinguishes chat and embedding and rejects truncation and duplicate keys", async () => {
  const root = await setup(), path = join(root, "model.gguf");
  await writeGguf(path);
  expect(await inspectModelCandidate({ modelPath: path, alias: "chat" }, "linux")).toMatchObject({ kind: "chat", model: { gpuLayers: 0, contextTokens: 32768 } });
  await writeGguf(path, [["llama.pooling_type", 1]]);
  expect(await inspectModelCandidate({ modelPath: path, alias: "embed" }, "darwin")).toMatchObject({ kind: "embedding", model: { pooling: "mean", port: 8081, gpuLayers: "auto" } });
  await writeGguf(path, [["general.architecture", "llama"]]);
  await expect(inspectGguf(path)).rejects.toMatchObject({ code: "invalid_gguf_metadata" });
  await writeFile(path, ggufBytes([["general.architecture", "llama"]]).subarray(0, 25));
  await expect(inspectGguf(path)).rejects.toMatchObject({ code: "invalid_gguf_metadata" });
});
test("validation enforces trained context, split files, CPU-only hosts and custom template digest", async () => {
  const root = await setup(), settings = serverSettings(root), model = settings.models[0]!;
  await writeGguf(model.modelPath);
  await expect(validateServerModels({ ...settings, models: [{ ...model, contextTokens: 65536 }] })).rejects.toThrow();
  await expect(validateServerModels({ ...settings, models: [{ ...model, gpuLayers: "auto" }] }, "linux")).rejects.toMatchObject({ code: "cpu_only_server" });
  const templatePath = join(root, "template.jinja"); await writeFile(templatePath, "{{ messages }}");
  Object.assign(model, await inspectTemplate(templatePath));
  expect((await validateServerModels(settings)).models[0]).toMatchObject(model);
  await writeFile(templatePath, "{{ changed }}");
  await expect(validateServerModels(settings)).rejects.toThrow();
  await writeGguf(model.modelPath, [["split.count", 2]]);
  await expect(inspectModelCandidate({ modelPath: model.modelPath, alias: "split" })).rejects.toThrow();
});
test("presets keep chat instances lazy, isolate cache and propagate sleep to embeddings", async () => {
  const root = await setup(), settings = serverSettings(root);
  const preset = await createServerPresets(root, settings);
  const ini = await readFile(preset.path, "utf8");
  expect(ini).toContain("load-on-startup = false"); expect(ini).toContain("sleep-idle-seconds = 60");
  expect(ini).toContain("alias = chat:one"); expect(preset.cache).not.toBe(root);
  const argv = embeddingArguments({ ...settings.models[0]!, port: 8081, pooling: "last", batchTokens: 512 }, -1);
  expect(argv.slice(argv.indexOf("--sleep-idle-seconds"), -1)).toEqual(["--sleep-idle-seconds", "-1"]);
  await preset.remove(); expect(await readdir(root)).toEqual([]);
});
test("Ollama discovery reads supported local blobs and isolates a corrupt manifest", async () => {
  const root = await setup(), dir = join(root, "manifests", "registry.ollama.ai", "library", "test");
  await mkdir(dir, { recursive: true }); await mkdir(join(root, "blobs"));
  async function blob(bytes: Buffer) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(root, "blobs", "sha256-" + hash), bytes);
    return { digest: "sha256:" + hash, size: bytes.length };
  }
  const config = await blob(Buffer.from('{"model_format":"gguf"}'));
  const weights = await blob(ggufBytes([["general.architecture", "llama"], ["llama.context_length", 4096], ["tokenizer.chat_template", "{{ messages }}"]]));
  await writeFile(join(dir, "latest"), JSON.stringify({ schemaVersion: 2, config, layers: [{ ...weights, mediaType: "application/vnd.ollama.image.model" }] }));
  await writeFile(join(dir, "broken"), "{}");
  const found = await discoverOllamaModels(root, "linux");
  expect(found.candidates).toHaveLength(1); expect(found.candidates[0]!.model.alias).toBe("test:latest");
  expect(found.skipped.map(value => value.alias)).toEqual(["test:broken"]);
});
