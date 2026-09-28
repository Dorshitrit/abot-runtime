import type { PassiveLearningPreferences } from "./contracts.js";

type ActivityPermissions = NonNullable<PassiveLearningPreferences["activityPermissions"]>;
type ActivityControls = Pick<PassiveLearningPreferences,
  "activityPermissions" | "enabled" | "processingPaused" | "proactiveEnabled">;

function readActivityPermissions(value: unknown): ActivityPermissions | undefined {
  if (value === undefined) return undefined;
  if (!isActivityPermissions(value)) throw new Error("invalid_learning_preferences");
  return Object.freeze({ collection: value.collection, learning: value.learning, proactive: value.proactive });
}

function isActivityPermissions(value: unknown): value is ActivityPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  if (Object.keys(permissions).length !== 3) return false;
  return ["collection", "learning", "proactive"].every((key) => typeof permissions[key] === "boolean");
}

/** Old API clients retain their existing switches until authorization is explicitly saved. */
export function normalizeLearningActivityControls(
  input: Partial<PassiveLearningPreferences>, previous: PassiveLearningPreferences,
): ActivityControls {
  const permissions = readActivityPermissions(input.activityPermissions === undefined
    ? previous.activityPermissions : input.activityPermissions);
  const controls = {
    enabled: input.enabled ?? previous.enabled,
    processingPaused: input.processingPaused ?? previous.processingPaused ?? false,
    proactiveEnabled: input.proactiveEnabled ?? previous.proactiveEnabled ?? false,
  };
  if (!permissions) return controls;
  assertAuthorizedActivation(input, permissions);
  return {
    activityPermissions: permissions,
    enabled: permissions.collection && controls.enabled,
    processingPaused: !permissions.learning || resolveAuthorizedLearningPause(input, previous),
    proactiveEnabled: permissions.proactive && controls.proactiveEnabled,
  };
}

function resolveAuthorizedLearningPause(
  input: Partial<PassiveLearningPreferences>, previous: PassiveLearningPreferences,
): boolean {
  if (input.processingPaused !== undefined) return input.processingPaused;
  if (!previous.modelProfileId) return true;
  return previous.processingPaused ?? false;
}

function assertAuthorizedActivation(input: Partial<PassiveLearningPreferences>, permissions: ActivityPermissions): void {
  if (input.enabled === true && !permissions.collection) throw new Error("learning_activity_not_allowed");
  if (input.processingPaused === false && !permissions.learning) throw new Error("learning_activity_not_allowed");
  if (input.proactiveEnabled === true && !permissions.proactive) throw new Error("learning_activity_not_allowed");
}

function requiresPermissionModelValidation(
  allowed: boolean, previouslyAllowed: boolean | undefined,
  profile: string | null | undefined, previousProfile: string | null | undefined,
  starting: boolean,
): boolean {
  if (!allowed) return false;
  if (!previouslyAllowed) return true;
  if (profile !== previousProfile) return true;
  return starting;
}

/** Authorizing an activity validates its model without starting a review or invoking a model. */
export function validateLearningActivityModels(
  previous: PassiveLearningPreferences, next: PassiveLearningPreferences,
  validateProfile: (profile: string) => void,
): void {
  const permissions = next.activityPermissions;
  if (!permissions) return;
  const old = previous.activityPermissions ?? {
    collection: previous.enabled,
    learning: Boolean(previous.modelProfileId && !previous.processingPaused),
    proactive: Boolean(previous.proactiveEnabled),
  };
  const learningModel = next.modelProfileId;
  const collectionNeedsModel = requiresPermissionModelValidation(
    permissions.collection, old.collection, learningModel, previous.modelProfileId,
    next.enabled && !previous.enabled,
  );
  const learningNeedsModel = requiresPermissionModelValidation(
    permissions.learning, old.learning, learningModel, previous.modelProfileId,
    !next.processingPaused && Boolean(previous.processingPaused),
  );
  const learningModelNeedsValidation = collectionNeedsModel || learningNeedsModel;
  validateRequiredActivityModel(learningModelNeedsValidation, learningModel, "learning_model_required", validateProfile);
  const proactiveModel = next.proactiveModelProfileId ?? learningModel;
  const proactiveNeedsModel = requiresPermissionModelValidation(
    permissions.proactive, old.proactive, proactiveModel,
    previous.proactiveModelProfileId ?? previous.modelProfileId,
    Boolean(next.proactiveEnabled && !previous.proactiveEnabled),
  );
  if (!proactiveNeedsModel) return;
  if (proactiveModel === learningModel && learningModelNeedsValidation) return;
  validateRequiredActivityModel(true, proactiveModel, "proactive_model_required", validateProfile);
}

function validateRequiredActivityModel(
  required: boolean, profile: string | null | undefined, missingReason: string,
  validateProfile: (profile: string) => void,
): void {
  if (!required) return;
  if (!profile) throw new Error(missingReason);
  validateProfile(profile);
}
