import { randomBytes } from "node:crypto";
import { serverFailure, type ServerSettings } from "./settings.js";
import { presetId } from "./presets.js";

export interface ModelObservation { alias: string; state: "unloaded" | "loading" | "loaded" | "sleeping" | "failed" | "unknown" }
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw serverFailure("server_status_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) throw serverFailure("server_status_unavailable");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function observeRouter(port: number, key: string, settings: ServerSettings, signal: AbortSignal): Promise<ModelObservation[]> {
  const response = await fetch("http://127.0.0.1:" + port + "/models", {
    headers: { Authorization: "Bearer " + key }, signal, redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw serverFailure("server_status_unavailable"); }
  const body = await readJson(response) as { data?: unknown };
  if (!body || !Array.isArray(body.data)) throw serverFailure("server_status_unavailable");
  const entries = body.data as { id?: unknown; aliases?: unknown; status?: { value?: unknown; failed?: unknown } }[];
  return settings.models.map(model => {
    const entry = entries.find(entry => entry && (entry.id === presetId(model.alias) || entry.id === model.alias
      || (Array.isArray(entry.aliases) && entry.aliases.includes(model.alias))));
    if (!entry) throw serverFailure("server_catalog_mismatch");
    if (entry.status?.failed === true) return { alias: model.alias, state: "failed" };
    const state = entry.status?.value;
    return { alias: model.alias, state: ["unloaded", "loading", "loaded", "sleeping"].includes(String(state)) ? state as ModelObservation["state"] : "unknown" };
  });
}
export async function routerReady(port: number, key: string, settings: ServerSettings, signal: AbortSignal): Promise<boolean> {
  const denied = await fetch("http://127.0.0.1:" + port + "/models", {
    headers: { Authorization: "Bearer " + randomBytes(32).toString("hex") }, signal, redirect: "error" });
  const protectedEndpoint = denied.status === 401 || denied.status === 403;
  await denied.body?.cancel();
  if (!protectedEndpoint) return false;
  await observeRouter(port, key, settings, signal);
  return true;
}
