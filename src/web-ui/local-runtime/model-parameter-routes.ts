import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { DEFAULT_RUNTIME_CONFIG_FILE } from "../../runtime/config/constants.js";
import { isRecord, resolveRuntimePath } from "../../runtime/config/utils.js";
import { getConfigDashboardSnapshot } from "../config-dashboard-backend.js";
import { buildConfigModelParameterPresentations, type ModelParameterPreviewCandidate } from "../model-parameter-presentation.js";
import { assertConfigMutationRequest, ConfigMutationRequestError } from "./config-mutation-request.js";
import { readBody, readJsonBody, sendJson } from "./http.js";

function requireCandidateKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported parameter preview field.");
}

function readCandidateModel(value: unknown): ModelParameterPreviewCandidate["models"][number] {
  if (!isRecord(value)) throw new Error("A model candidate is required.");
  requireCandidateKeys(value, ["id", "provider", "model", "supportsThinking", "generation", "calibration", "options"]);
  if (typeof value.id !== "string" || !value.id) throw new Error("A known model identity is required.");
  if (typeof value.provider !== "string" || typeof value.model !== "string") throw new Error("Provider and model identities are required.");
  if (value.supportsThinking !== undefined && typeof value.supportsThinking !== "boolean") throw new Error("Invalid reasoning capability.");
  if (value.generation !== undefined && !isRecord(value.generation)) throw new Error("Invalid generation candidate.");
  if (value.options !== undefined && !isRecord(value.options)) throw new Error("Invalid native parameter options.");
  if (value.calibration !== undefined && !isRecord(value.calibration)) throw new Error("Invalid calibration candidate.");
  for (const entry of Object.values(value.calibration ?? {})) {
    if (!isRecord(entry)) throw new Error("Invalid calibration candidate.");
    requireCandidateKeys(entry, ["profileId", "generation"]);
    if (entry.profileId !== undefined && typeof entry.profileId !== "string") throw new Error("Invalid calibration target.");
    if (entry.generation !== undefined && !isRecord(entry.generation)) throw new Error("Invalid calibration generation.");
  }
  return value as ModelParameterPreviewCandidate["models"][number];
}

export function parseModelParameterPreviewCandidate(value: Record<string, unknown>): ModelParameterPreviewCandidate {
  requireCandidateKeys(value, ["modelId", "models", "providers", "environment"]);
  if (typeof value.modelId !== "string" || !value.modelId) throw new Error("A model identity is required.");
  if (!Array.isArray(value.models) || value.models.length > 256) throw new Error("Invalid model candidates.");
  if (!isRecord(value.providers) || Object.keys(value.providers).length > 256) throw new Error("Invalid provider candidates.");
  const providers = Object.fromEntries(Object.entries(value.providers).map(([id, provider]) => {
    if (!isRecord(provider) || typeof provider.type !== "string") throw new Error("Invalid provider candidate.");
    requireCandidateKeys(provider, ["type"]);
    return [id, { type: provider.type }];
  }));
  const models = value.models.map(readCandidateModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("Duplicate model candidates.");
  return { modelId: value.modelId, models, providers };
}

export async function handleModelParameterPreviewRoute(params: {
  method: string; route: string; request: IncomingMessage; response: ServerResponse;
  rootDir: string; configPath?: string;
}): Promise<boolean> {
  if (params.route !== "runtime/config/model-parameters/preview") return false;
  params.response.setHeader("cache-control", "no-store");
  if (params.method !== "POST") {
    sendJson(params.response, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  try {
    assertConfigMutationRequest(params.request);
    const candidate = parseModelParameterPreviewCandidate(readJsonBody(await readBody(params.request, { maxBytes: 131_072 })));
    const snapshot = await getConfigDashboardSnapshot({ rootDir: params.rootDir, configPath: params.configPath, includeModelParameters: false });
    const knownIds = new Set(snapshot.files.models.map((model) => model.id));
    if (!knownIds.has(candidate.modelId) || candidate.models.some((model) => !knownIds.has(model.id))) throw new Error("Unknown model candidate.");
    const mainConfigPath = params.configPath
      ? resolveRuntimePath(params.rootDir, params.configPath)
      : resolve(params.rootDir, DEFAULT_RUNTIME_CONFIG_FILE);
    const presentations = buildConfigModelParameterPresentations(snapshot, mainConfigPath, candidate);
    sendJson(params.response, 200, { ok: true, presentation: presentations[candidate.modelId] });
  } catch (error) {
    const status = error instanceof ConfigMutationRequestError ? error.statusCode : 400;
    sendJson(params.response, status, { ok: false, error: "model_parameter_preview_rejected", message: "Model parameter preview requires valid model settings and same-origin JSON." });
  }
  return true;
}
