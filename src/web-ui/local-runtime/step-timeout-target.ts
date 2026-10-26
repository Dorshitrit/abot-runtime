import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalConfigFilePath } from "../../runtime/adapters/config-file-transaction.js";
import { buildRuntimeModelConfiguration } from "../../runtime/config/builders.js";
import { parseRequestRunnerConfig } from "../../runtime/config/runner/versioned-config.js";
import { isRecord } from "../../runtime/config/utils.js";
import type { ConfigDashboardSnapshot } from "../config-dashboard-backend.js";

export type StepTimeoutReceipt = Readonly<{
  requestId: string;
  invocationId: string;
  modelStep: string;
  timeoutMs: number;
  configuredTimeoutMs: number;
  timeoutSource: "runner" | "model_calibration";
  configurationProfileId?: string;
  calibrationSlotId?: string;
  profileId: string;
  model: string;
  provider: string;
}>;

export type StepTimeoutSuggestion = Readonly<{
  configurationProfileId?: string;
  profileId: string;
  model: string;
  modelStep: string;
  calibrationSlotId?: string;
  timeoutMs: number;
  proposedTimeoutMs: number;
  canIncrease: boolean;
  reason?: string;
  revision?: string;
}>;

type ModelFile = ConfigDashboardSnapshot["files"]["models"][number];
export type StepTimeoutTarget = Readonly<{
  suggestion: StepTimeoutSuggestion;
  file?: ModelFile;
  candidate?: Record<string, unknown>;
  currentTimeoutMs?: number;
}>;

export function timeoutConfigurationRevision(
  snapshot: ConfigDashboardSnapshot,
): string {
  const selectedFiles = [
    snapshot.files.runtime,
    snapshot.files.requestRunner,
    ...snapshot.files.models
      .filter((file) => file.registered)
      .sort((left, right) => left.id.localeCompare(right.id)),
  ];
  return createHash("sha256")
    .update(
      JSON.stringify(
        selectedFiles.map(
          (file) =>
            file && { id: file.id, path: file.path, config: file.config },
        ),
      ),
    )
    .digest("hex");
}

export function timeoutCandidateSnapshot(
  snapshot: ConfigDashboardSnapshot,
  file: ModelFile,
  candidate: Record<string, unknown>,
): ConfigDashboardSnapshot {
  const changed = structuredClone(snapshot);
  changed.files.models = changed.files.models.map((entry) =>
    entry.id === file.id ? { ...entry, config: candidate } : entry,
  );
  if (!file.source) return changed;
  const models = changed.files.runtime.config.models as Record<string, unknown>;
  const profiles = models.profiles as Record<string, unknown>;
  profiles[file.id] = candidate;
  return changed;
}

function timeoutProfileDeclaration(
  snapshot: ConfigDashboardSnapshot,
  id: string,
) {
  const models = snapshot.files.runtime.config.models;
  if (!isRecord(models) || !isRecord(models.profiles)) return undefined;
  const declaration = models.profiles[id];
  return isRecord(declaration) ? declaration : undefined;
}

async function ambiguousProfileStorage(
  snapshot: ConfigDashboardSnapshot,
  file: ModelFile,
): Promise<string | undefined> {
  if (file.source) return undefined;
  const targetPath = await canonicalConfigFilePath(
    resolve(snapshot.rootDir, file.path),
  );
  const registeredPaths = await Promise.all(
    snapshot.files.models
      .filter((entry) => entry.registered)
      .map((entry) =>
        canonicalConfigFilePath(resolve(snapshot.rootDir, entry.path)),
      ),
  );
  const aliases = registeredPaths.filter((path) => path === targetPath);
  if (aliases.length > 1) return "shared_profile_file";
  const declaration = timeoutProfileDeclaration(snapshot, file.id);
  if (!declaration) return "profile_changed";
  if (Object.keys(declaration).some((key) => key !== "configRef"))
    return "profile_inline_overrides";
  return undefined;
}

/** The saved event identifies authority; browser fields never select a target. */
export async function resolveStepTimeoutTarget(
  snapshot: ConfigDashboardSnapshot,
  receipt: StepTimeoutReceipt,
): Promise<StepTimeoutTarget> {
  const base: StepTimeoutSuggestion = {
    configurationProfileId: receipt.configurationProfileId,
    profileId: receipt.profileId,
    model: receipt.model,
    modelStep: receipt.modelStep,
    calibrationSlotId: receipt.calibrationSlotId,
    timeoutMs: receipt.timeoutMs,
    proposedTimeoutMs: receipt.timeoutMs * 2,
    canIncrease: false,
  };
  const unavailable = (reason: string): StepTimeoutTarget => ({
    suggestion: { ...base, reason },
  });
  if (
    !Number.isSafeInteger(base.proposedTimeoutMs) ||
    base.proposedTimeoutMs > 2_147_483_647
  )
    return unavailable("timeout_limit");
  if (!receipt.configurationProfileId || !receipt.calibrationSlotId)
    return unavailable("no_profile_step_target");
  const file = snapshot.files.models.find(
    (entry) => entry.registered && entry.id === receipt.configurationProfileId,
  );
  if (!file?.exists || file.invalidJson) return unavailable("profile_changed");
  const storageReason = await ambiguousProfileStorage(snapshot, file);
  if (storageReason) return unavailable(storageReason);
  const runnerFile = snapshot.files.requestRunner;
  if (!runnerFile?.exists || runnerFile.invalidJson)
    return unavailable("runner_unavailable");
  const runner = parseRequestRunnerConfig(runnerFile.config, runnerFile.path);
  if (
    runner.steps[receipt.modelStep]?.timeoutMs !== receipt.configuredTimeoutMs
  )
    return unavailable("runner_timeout_changed");
  const slot = runner.models.defaults.steps[receipt.modelStep];
  if (slot !== receipt.calibrationSlotId)
    return unavailable("step_binding_changed");
  const policy = buildRuntimeModelConfiguration(snapshot.files.runtime.config, {
    mainConfigPath: resolve(snapshot.rootDir, snapshot.files.runtime.path),
  }).modelPolicy;
  if (policy?.profiles?.[slot] || policy?.invocationProfiles?.[slot])
    return unavailable("direct_profile_selection");
  const sharingSteps = Object.values(runner.models.defaults.steps).filter(
    (target) => target === slot,
  );
  if (sharingSteps.length !== 1) return unavailable("shared_calibration_slot");
  const profile = policy?.profiles?.[receipt.configurationProfileId];
  const calibration = profile?.calibration?.[slot];
  const actualProfileId =
    calibration?.profileId ?? receipt.configurationProfileId;
  const actualProfile = policy?.profiles?.[actualProfileId];
  const provider = actualProfile?.provider;
  const providerType = provider
    ? (policy?.providers?.[provider]?.type ?? provider)
    : undefined;
  if (
    actualProfileId !== receipt.profileId ||
    actualProfile?.model !== receipt.model ||
    providerType !== receipt.provider
  )
    return unavailable("model_binding_changed");
  const currentTimeoutMs =
    calibration?.timeoutMs ?? runner.steps[receipt.modelStep]?.timeoutMs;
  const originalStillConfigured = currentTimeoutMs === receipt.timeoutMs;
  const alreadyIncreased = currentTimeoutMs === base.proposedTimeoutMs;
  if (!originalStillConfigured && !alreadyIncreased)
    return unavailable("timeout_changed");
  if (
    originalStillConfigured &&
    receipt.timeoutSource === "model_calibration" &&
    calibration?.timeoutMs === undefined
  )
    return unavailable("timeout_source_changed");
  if (
    originalStillConfigured &&
    receipt.timeoutSource === "runner" &&
    calibration?.timeoutMs !== undefined
  )
    return unavailable("timeout_source_changed");
  const rawCalibration = isRecord(file.config.calibration)
    ? file.config.calibration
    : {};
  const rawSlot = isRecord(rawCalibration[slot]) ? rawCalibration[slot] : {};
  const candidate = {
    ...file.config,
    calibration: {
      ...rawCalibration,
      [slot]: { ...rawSlot, timeoutMs: base.proposedTimeoutMs },
    },
  };
  const before = timeoutConfigurationRevision(snapshot);
  const after = timeoutConfigurationRevision(
    timeoutCandidateSnapshot(snapshot, file, candidate),
  );
  return {
    suggestion: {
      ...base,
      canIncrease: !alreadyIncreased,
      ...(alreadyIncreased ? { reason: "already_saved" } : {}),
      revision: `${before}.${after}`,
    },
    file,
    candidate,
    currentTimeoutMs,
  };
}
