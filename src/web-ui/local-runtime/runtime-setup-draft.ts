import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalConfigFilePath,
  readConfigFileSnapshot,
} from "../../runtime/adapters/config-file-transaction.js";
import type { InspectedRuntimeConfigFile } from "../../runtime/config/loader.js";
import { isRecord } from "../../runtime/config/utils.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import { runtimeSetupDraftModelPath } from "./runtime-setup-model-file.js";
import {
  MalformedRuntimeSetupReceiptError,
  readRuntimeSetupReceipt,
  runtimeSetupReceiptPath,
  writeRuntimeSetupReceipt,
} from "./runtime-setup-receipt-file.js";

export type RuntimeSetupDraft = Readonly<{
  version: 1;
  revision: string;
  configPath: string;
  modelPath: string;
  modelConfig: Record<string, unknown>;
  profileReferences: Record<string, unknown>;
  ownedProviders: Record<string, unknown>;
}>;

export function setupConfigurationChanged(): RuntimeSetupError {
  return new RuntimeSetupError(
    "setup_configuration_changed",
    "This setup connection changed since it was loaded. Refresh before editing it again.",
    409,
  );
}

export function setupConfigMap(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isSetupDraft(
  value: Record<string, unknown>,
): value is RuntimeSetupDraft {
  if (value.version !== 1) return false;
  if (typeof value.revision !== "string") return false;
  if (typeof value.configPath !== "string") return false;
  if (typeof value.modelPath !== "string") return false;
  if (!isRecord(value.modelConfig)) return false;
  if (!isRecord(value.profileReferences)) return false;
  return isRecord(value.ownedProviders);
}

export async function readRuntimeSetupDraft(
  configPath: string,
): Promise<RuntimeSetupDraft | undefined> {
  const raw = await readRuntimeSetupReceipt(configPath);
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MalformedRuntimeSetupReceiptError();
  }
  if (!isRecord(value) || !isSetupDraft(value))
    throw new MalformedRuntimeSetupReceiptError();
  return value;
}

/** Ownership covers the newly created chat model and providers, never the whole config. */
export async function isCurrentRuntimeSetupDraft(
  source: InspectedRuntimeConfigFile,
  draft: RuntimeSetupDraft,
): Promise<boolean> {
  if ((await canonicalConfigFilePath(source.path)) !== draft.configPath)
    return false;
  const models = setupConfigMap(source.config.models);
  if (!isDeepStrictEqual(models.profiles, draft.profileReferences))
    return false;
  if ((await runtimeSetupDraftModelPath(source)) !== draft.modelPath)
    return false;
  const providers = setupConfigMap(models.providers);
  for (const [id, provider] of Object.entries(draft.ownedProviders)) {
    if (!isDeepStrictEqual(providers[id], provider)) return false;
  }
  const model = await readConfigFileSnapshot(draft.modelPath);
  return model.exists && isDeepStrictEqual(model.config, draft.modelConfig);
}

export async function writeRuntimeSetupDraft(
  draft: RuntimeSetupDraft,
): Promise<void> {
  await writeRuntimeSetupReceipt(draft.configPath, draft);
}

export async function createRuntimeSetupDraft(
  source: InspectedRuntimeConfigFile,
  previousProviders: Record<string, unknown>,
  providerId: string,
  modelConfig: Record<string, unknown>,
  ownedProviders?: Record<string, unknown>,
): Promise<RuntimeSetupDraft> {
  const models = setupConfigMap(source.config.models);
  const providers = setupConfigMap(models.providers);
  const modelPath = await runtimeSetupDraftModelPath(source);
  if (!modelPath) throw setupConfigurationChanged();
  const model = await readConfigFileSnapshot(modelPath);
  if (!isDeepStrictEqual(model.config, modelConfig))
    throw setupConfigurationChanged();
  const draft: RuntimeSetupDraft = {
    version: 1,
    revision: randomUUID(),
    configPath: await canonicalConfigFilePath(source.path),
    modelPath,
    modelConfig,
    profileReferences: setupConfigMap(models.profiles),
    ownedProviders:
      ownedProviders ??
      (Object.hasOwn(previousProviders, providerId)
        ? {}
        : { [providerId]: providers[providerId] }),
  };
  await writeRuntimeSetupDraft(draft);
  return draft;
}

export async function removeRuntimeSetupDraft(
  configPath: string,
): Promise<void> {
  await rm(await runtimeSetupReceiptPath(configPath), { force: true });
}

/** A broken ownership receipt must never grant edit access or block ordinary configuration. */
export async function inspectEditableRuntimeSetupDraft(
  source: InspectedRuntimeConfigFile,
): Promise<RuntimeSetupDraft | undefined> {
  try {
    const draft = await readRuntimeSetupDraft(source.path);
    if (!draft) return undefined;
    if (!(await isCurrentRuntimeSetupDraft(source, draft))) return undefined;
    return draft;
  } catch {
    return undefined;
  }
}
