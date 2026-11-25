import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { canonicalManagedDirectory, createPrivateManagedDirectory, createManagedFile, verifyPrivateManagedFile } from "../host-files.js";
import { parseServerSettings, type ServerSettings, type ServerEmbedding } from "./settings.js";

export function presetId(alias: string): string {
  return "abot-" + createHash("sha256").update(alias).digest("hex").slice(0, 24);
}
export function renderServerPresets(input: ServerSettings): string {
  const settings = parseServerSettings(input);
  const lines = ["version = 1", "", "[*]", "load-on-startup = false", "parallel = 1", "jinja = true",
    "sleep-idle-seconds = " + settings.sleepIdleSeconds];
  for (const model of settings.models) {
    lines.push("", "[" + presetId(model.alias) + "]", "model = " + model.modelPath,
      "alias = " + model.alias, "ctx-size = " + model.contextTokens, "n-gpu-layers = " + model.gpuLayers);
    if (model.templatePath) lines.push("chat-template-file = " + model.templatePath);
    if (model.projectorPath) lines.push("mmproj = " + model.projectorPath);
  }
  return lines.join("\n") + "\n";
}
export async function createServerPresets(directory: string, settings: ServerSettings): Promise<{ path: string; cache: string; remove(): Promise<void> }> {
  const content = renderServerPresets(settings);
  const cache = join(directory, ".server-run-" + randomBytes(16).toString("hex"));
  await createPrivateManagedDirectory(cache);
  const path = join(cache, "models.ini");
  let file;
  try {
    file = await createManagedFile(path);
    await verifyPrivateManagedFile(path, await file.stat(), 0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
  } catch (error) {
    await file?.close();
    await canonicalManagedDirectory(cache, true);
    await rm(cache, { recursive: true });
    throw error;
  }
  await file.close();
  return { path, cache, async remove() {
    await canonicalManagedDirectory(cache, true);
    await rm(cache, { recursive: true });
  } };
}
export function routerArguments(settings: ServerSettings, presetPath: string): string[] {
  return ["--host", "127.0.0.1", "--port", String(settings.port), "--models-preset", presetPath,
    "--models-max", String(settings.maxLoadedModels), "--models-autoload", "--offline"];
}
export function embeddingArguments(model: ServerEmbedding, sleepIdleSeconds: number): string[] {
  return ["--host", "127.0.0.1", "--port", String(model.port), "--model", model.modelPath,
    "--alias", model.alias, "--embedding", "--pooling", model.pooling,
    "--ctx-size", String(model.contextTokens), "--parallel", "1", "--batch-size", String(model.batchTokens),
    "--ubatch-size", String(model.batchTokens), "--n-gpu-layers", String(model.gpuLayers),
    "--sleep-idle-seconds", String(sleepIdleSeconds), "--offline"];
}
