import { isAbsolute } from "node:path";
import { ManagedLlamaError } from "../contracts.js";

export interface ServerModel {
  alias: string;
  modelPath: string;
  contextTokens: number;
  gpuLayers: number | "auto";
  templatePath?: string;
  templateSha256?: string;
  projectorPath?: string;
}
export interface ServerEmbedding extends ServerModel {
  port: number;
  batchTokens: number;
  pooling: "mean" | "cls" | "last";
}
export interface ServerSettings {
  startup: "manual" | "with-abot";
  port: number;
  sleepIdleSeconds: number;
  maxLoadedModels: number;
  models: ServerModel[];
  embedding: ServerEmbedding | null;
}

export function serverFailure(code: string): ManagedLlamaError {
  return new ManagedLlamaError(code, "Managed llama.cpp server: " + code + ".");
}
function invalid(): never { throw serverFailure("invalid_server_settings"); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const keys = Object.keys(value);
  if (required.some(key => !keys.includes(key))) return invalid();
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return invalid();
  if (value < minimum || value > maximum) return invalid();
  return value;
}
export function serverPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096) return invalid();
  // Presets have no escaping convention: reject INI syntax rather than quote it.
  if (value !== value.trim() || /[\u0000-\u001f\u007f#;\[\]]/u.test(value)) return invalid();
  return value;
}
export function serverAlias(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) return invalid();
  return value;
}
const modelFields = ["alias", "modelPath", "contextTokens", "gpuLayers"];
const optionalFields = ["templatePath", "templateSha256", "projectorPath"];
function model(value: unknown, embedding = false): ServerModel | ServerEmbedding {
  const extra = embedding ? ["port", "batchTokens", "pooling"] : [];
  const entry = object(value, [...modelFields, ...extra], optionalFields);
  const result: ServerModel = { alias: serverAlias(entry.alias), modelPath: serverPath(entry.modelPath),
    contextTokens: integer(entry.contextTokens, 512, 131072),
    gpuLayers: entry.gpuLayers === "auto" ? "auto" : integer(entry.gpuLayers, 0, 999) };
  if (entry.templatePath !== undefined) {
    result.templatePath = serverPath(entry.templatePath);
    if (typeof entry.templateSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.templateSha256)) return invalid();
    result.templateSha256 = entry.templateSha256;
  } else if (entry.templateSha256 !== undefined) return invalid();
  if (entry.projectorPath !== undefined) result.projectorPath = serverPath(entry.projectorPath);
  if (!embedding) return result;
  if (!["mean", "cls", "last"].includes(String(entry.pooling))) return invalid();
  if (result.templatePath || result.projectorPath) return invalid();
  return { ...result, port: integer(entry.port, 1024, 65535),
    batchTokens: integer(entry.batchTokens, 1, result.contextTokens), pooling: entry.pooling as ServerEmbedding["pooling"] };
}
export function parseServerSettings(value: unknown): ServerSettings {
  const entry = object(value, ["startup", "port", "sleepIdleSeconds", "maxLoadedModels", "models", "embedding"]);
  if (entry.startup !== "manual" && entry.startup !== "with-abot") return invalid();
  if (!Array.isArray(entry.models) || entry.models.length < 1 || entry.models.length > 64) return invalid();
  const models = entry.models.map(value => model(value) as ServerModel);
  if (new Set(models.map(value => value.alias)).size !== models.length) return invalid();
  const result: ServerSettings = { startup: entry.startup, port: integer(entry.port, 1024, 65535),
    sleepIdleSeconds: entry.sleepIdleSeconds === -1 ? -1 : integer(entry.sleepIdleSeconds, 1, 86400),
    maxLoadedModels: integer(entry.maxLoadedModels, 1, 8), models,
    embedding: entry.embedding === null ? null : model(entry.embedding, true) as ServerEmbedding };
  if (result.embedding?.port === result.port) return invalid();
  if (result.embedding && models.some(value => value.alias === result.embedding!.alias)) return invalid();
  return result;
}
