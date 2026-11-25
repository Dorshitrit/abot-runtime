import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { openManagedRead } from "../host-files.js";
import { inspectGguf } from "./gguf-metadata.js";
import { serverFailure, serverPath, type ServerModel, type ServerSettings } from "./settings.js";

function requireModel(value: unknown): asserts value { if (!value) throw serverFailure("unsupported_server_model"); }
export async function inspectTemplate(path: string): Promise<{ templatePath: string; templateSha256: string }> {
  const canonical = serverPath(await realpath(serverPath(path)));
  const file = await openManagedRead(canonical);
  try {
    const stat = await file.stat();
    requireModel(stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024);
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await file.stat();
    requireModel(size === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs);
    const content = bytes.subarray(0, size);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    requireModel(text.includes("{{") || text.includes("{%"));
    return { templatePath: canonical, templateSha256: createHash("sha256").update(content).digest("hex") };
  } finally { await file.close(); }
}
export async function validateServerModel(model: ServerModel, embedding = false): Promise<ServerModel> {
  const inspected = await inspectGguf(model.modelPath), data = inspected.metadata;
  requireModel((data["split.count"] ?? 1) === 1 && (data["split.no"] ?? 0) === 0);
  const architecture = data["general.architecture"];
  requireModel(typeof architecture === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(architecture));
  const capacity = data[architecture + ".context_length"];
  requireModel(typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity >= model.contextTokens);
  const pooling = data[architecture + ".pooling_type"] ?? 0;
  requireModel(embedding ? [1, 2, 3].includes(Number(pooling)) : pooling === 0);
  const result = { ...model, modelPath: inspected.path };
  if (model.templatePath) {
    const template = await inspectTemplate(model.templatePath);
    requireModel(template.templateSha256 === model.templateSha256);
    Object.assign(result, template);
  }
  if (!embedding && !model.templatePath) {
    const template = data["tokenizer.chat_template"];
    requireModel(typeof template === "string" && (template.includes("{{") || template.includes("{%")));
  }
  if (model.projectorPath) result.projectorPath = (await inspectGguf(model.projectorPath)).path;
  return result;
}
export async function validateServerModels(settings: ServerSettings, os = process.platform): Promise<ServerSettings> {
  const models: ServerModel[] = [];
  const all = [...settings.models, ...(settings.embedding ? [settings.embedding] : [])];
  if (os !== "darwin" && all.some(model => model.gpuLayers !== 0)) throw serverFailure("cpu_only_server");
  for (const model of settings.models) models.push(await validateServerModel(model));
  let embedding = settings.embedding;
  if (embedding) {
    const validated = await validateServerModel(embedding, true);
    const { metadata } = await inspectGguf(validated.modelPath);
    const pooling = ["", "mean", "cls", "last"][Number(metadata[metadata["general.architecture"] + ".pooling_type"])];
    requireModel(embedding.pooling === pooling);
    embedding = { ...embedding, ...validated };
  }
  return { ...settings, models, embedding };
}
