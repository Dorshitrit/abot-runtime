import { realpath } from "node:fs/promises";
import { isLocalModelPath, openManagedRead } from "./host-files.js";
import { requireValue, type LaunchSettings } from "./contracts.js";

function integer(value: unknown, min: number, max: number, name: string): number {
  requireValue(typeof value === "number" && Number.isInteger(value) && value >= min && value <= max, "invalid_launch", "Invalid " + name + ".");
  return value;
}

export async function validateLaunch(value: unknown): Promise<LaunchSettings> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), "invalid_launch", "Launch settings must be an object.");
  const input = value as Record<string, unknown>;
  const { modelPath, alias } = input;
  requireValue(typeof modelPath === "string" && modelPath.length > 0 && modelPath.length <= 4096 && isLocalModelPath(modelPath) && !/[\u0000-\u001f\u007f]/u.test(modelPath) && modelPath.toLowerCase().endsWith(".gguf"), "invalid_model_path", "Choose an absolute GGUF file path of at most 4096 characters.");
  requireValue(typeof alias === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias), "invalid_alias", "Use a simple model alias of 1–64 characters.");
  const port = integer(input.port, 1024, 65535, "port");
  const contextTokens = integer(input.contextTokens, 512, 131072, "context window");
  const gpuLayers = integer(input.gpuLayers, 0, 999, "GPU layers");
  requireValue(process.platform === "darwin" || gpuLayers === 0, "invalid_launch", "This managed engine supports CPU only; GPU layers must be zero.");
  const normalized = await realpath(modelPath);
  requireValue(normalized.length <= 4096 && normalized.toLowerCase().endsWith(".gguf"), "invalid_model_path", "Resolved file must be a GGUF path within the path limit.");
  const file = await openManagedRead(normalized);
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size >= 24, "invalid_gguf", "Model must be a regular GGUF file of at least 24 bytes.");
    const header = Buffer.alloc(8);
    let offset = 0;
    while (offset < header.length) {
      const { bytesRead } = await file.read(header, offset, header.length - offset, offset);
      requireValue(bytesRead > 0, "invalid_gguf", "GGUF header is incomplete.");
      offset += bytesRead;
    }
    requireValue(header.toString("ascii", 0, 4) === "GGUF" && [2, 3].includes(header.readUInt32LE(4)), "invalid_gguf", "Expected GGUF version 2 or 3.");
  } finally {
    await file.close();
  }
  return { modelPath: normalized, port, alias, contextTokens, gpuLayers };
}
