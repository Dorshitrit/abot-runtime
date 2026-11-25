import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { openManagedRead } from "../host-files.js";
import { inspectGguf } from "./gguf-metadata.js";
import { inspectTemplate, validateServerModel } from "./model-validation.js";
import { serverAlias, serverFailure, serverPath, type ServerModel, type ServerEmbedding } from "./settings.js";

export async function inspectModelCandidate(input: { modelPath: string; alias: string; templatePath?: string; projectorPath?: string }, os = process.platform) {
  const { path, metadata } = await inspectGguf(input.modelPath);
  const architecture = metadata["general.architecture"], capacity = metadata[architecture + ".context_length"];
  if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 512) throw serverFailure("unsupported_server_model");
  const pooling = ["", "mean", "cls", "last"][Number(metadata[architecture + ".pooling_type"] ?? 0)];
  const model: ServerModel = { alias: serverAlias(input.alias), modelPath: path,
    contextTokens: Math.min(32768, capacity, 131072), gpuLayers: os === "darwin" ? "auto" : 0 };
  if (input.templatePath) Object.assign(model, await inspectTemplate(input.templatePath));
  if (input.projectorPath) model.projectorPath = serverPath(input.projectorPath);
  const kind = pooling ? "embedding" : "chat";
  if (kind === "embedding") {
    model.contextTokens = Math.min(8192, model.contextTokens);
    const embedding: ServerEmbedding = { ...model, port: 8081, batchTokens: Math.min(512, model.contextTokens), pooling: pooling as ServerEmbedding["pooling"] };
    await validateServerModel(embedding, true);
    return { kind, model: embedding };
  }
  return { kind, model: await validateServerModel(model) };
}
async function boundedBytes(path: string): Promise<Buffer> {
  const file = await openManagedRead(path);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw serverFailure("invalid_model_manifest");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) throw serverFailure("invalid_model_manifest");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function blob(root: string, descriptor: unknown, verifyDigest = false): Promise<string> {
  const entry = descriptor as { digest?: unknown; size?: unknown };
  if (!entry || typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.digest)
    || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw serverFailure("invalid_model_manifest");
  const path = join(root, "blobs", entry.digest.replace(":", "-"));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw serverFailure("invalid_model_manifest");
  if (verifyDigest && createHash("sha256").update(await boundedBytes(path)).digest("hex") !== entry.digest.slice(7)) throw serverFailure("invalid_model_manifest");
  return path;
}
async function manifests(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [{ path: root, depth: 0 }];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > 8) throw serverFailure("model_catalog_too_large");
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      if (++entries > 2048) throw serverFailure("model_catalog_too_large");
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) pending.push({ path, depth: current.depth + 1 });
      if (entry.isFile()) found.push(path);
    }
  }
  return found.sort();
}
export async function discoverOllamaModels(directory = join(homedir(), ".ollama", "models"), os = process.platform) {
  const root = serverPath(await realpath(serverPath(directory)));
  const manifestRoot = join(root, "manifests");
  if (await realpath(manifestRoot) !== manifestRoot || await realpath(join(root, "blobs")) !== join(root, "blobs")) throw serverFailure("invalid_model_manifest");
  const candidates: Awaited<ReturnType<typeof inspectModelCandidate>>[] = [], skipped: { alias: string; reason: string }[] = [];
  for (const path of await manifests(manifestRoot)) {
    const parts = relative(manifestRoot, path).split(sep);
    if (parts.length < 4) continue;
    const [registry, namespace, ...name] = parts;
    const tag = name.pop();
    const prefix = registry === "registry.ollama.ai" && namespace === "library" ? "" : registry + "/" + namespace + "/";
    const alias = prefix + name.join("/") + ":" + tag;
    try {
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(path)));
      if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length > 128) throw serverFailure("invalid_model_manifest");
      const configuration = JSON.parse((await boundedBytes(await blob(root, manifest.config, true))).toString("utf8"));
      if (configuration.model_format !== "gguf") throw serverFailure("unsupported_server_model");
      const weights = manifest.layers.filter((layer: { mediaType?: string }) => layer?.mediaType === "application/vnd.ollama.image.model");
      const projectors = manifest.layers.filter((layer: { mediaType?: string }) => layer?.mediaType === "application/vnd.ollama.image.projector");
      if (weights.length !== 1 || projectors.length > 1) throw serverFailure("unsupported_server_model");
      candidates.push(await inspectModelCandidate({ alias, modelPath: await blob(root, weights[0]),
        ...(projectors.length ? { projectorPath: await blob(root, projectors[0]) } : {}) }, os));
      if (candidates.length > 64) throw serverFailure("model_catalog_too_large");
    } catch (error) {
      if ((error as { code?: string }).code === "model_catalog_too_large") throw error;
      skipped.push({ alias, reason: "Model metadata, template or local files are not supported. Add the GGUF with an explicit template if needed." });
    }
  }
  return { candidates, skipped };
}
