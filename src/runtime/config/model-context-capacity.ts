import type {
  ModelContextConfig,
  ModelGatewayPolicyConfig,
} from "../../model-gateway/types.js";
import type { RequestRunnerConfig } from "./runner/contracts.js";

export type ModelContextCapacityIssue = Readonly<{
  profileId: string;
  declaredTokens: number;
  effectiveTokens: number;
  reservedTokens: number;
  minimumTokens: number;
  allocationTokens?: number;
}>;

function readPositiveContextCapacity(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isSafeInteger(value)) return undefined;
  if (value <= 0) return undefined;
  return value;
}

function hasConfiguredOllamaContextAllocation(
  providerType: string | undefined,
  profile: NonNullable<ModelGatewayPolicyConfig["profiles"]>[string],
): boolean {
  if (providerType !== "ollama") return false;
  return Object.hasOwn(profile.options ?? {}, "num_ctx");
}

function hasInsufficientModelContextCapacity(
  effectiveTokens: number,
  reservedTokens: number,
): boolean {
  return reservedTokens >= effectiveTokens;
}

/** Keeps the admission invariant and its diagnostic evidence in one owner. */
export function validateProfileContextCapacity(params: {
  issues: string[];
  capacityIssues: ModelContextCapacityIssue[];
  profileId: string;
  profile: NonNullable<ModelGatewayPolicyConfig["profiles"]>[string];
  providerType?: string;
  runnerConfig: RequestRunnerConfig;
  defaultContext?: ModelContextConfig;
}): void {
  const field = `models.profiles.${params.profileId}.contextWindowTokens`;
  const declaredTokens = readPositiveContextCapacity(
    params.profile.contextWindowTokens,
  );
  if (declaredTokens === undefined) {
    params.issues.push(
      `${field} must declare the physical context-window capacity as a positive safe integer`,
    );
    return;
  }

  const hasAllocation = hasConfiguredOllamaContextAllocation(
    params.providerType,
    params.profile,
  );
  const allocationTokens = hasAllocation
    ? readPositiveContextCapacity(params.profile.options?.num_ctx)
    : undefined;
  const hasInvalidOllamaAllocation =
    hasAllocation && allocationTokens === undefined;
  if (hasInvalidOllamaAllocation) {
    params.issues.push(
      `models.profiles.${params.profileId}.options.num_ctx must be a positive safe integer when configured`,
    );
    return;
  }
  const effectiveTokens =
    allocationTokens === undefined
      ? declaredTokens
      : Math.min(declaredTokens, allocationTokens);
  const profileFormatReserve =
    params.profile.context?.formatTokenAccounting?.fixedOverheadTokens ?? 0;
  const defaultFormatReserve =
    params.defaultContext?.formatTokenAccounting?.fixedOverheadTokens ?? 0;
  const reservedTokens =
    params.runnerConfig.context.outputReserveTokens +
    params.runnerConfig.context.safetyReserveTokens +
    params.runnerConfig.context.attachmentReserveTokens +
    Math.max(profileFormatReserve, defaultFormatReserve);
  if (!hasInsufficientModelContextCapacity(effectiveTokens, reservedTokens))
    return;

  params.issues.push(
    `models.profiles.${params.profileId} effective context window ${effectiveTokens} must exceed configured output, safety, attachment, and format reserves ${reservedTokens}`,
  );
  params.capacityIssues.push({
    profileId: params.profileId,
    declaredTokens,
    effectiveTokens,
    reservedTokens,
    minimumTokens: reservedTokens + 1,
    ...(allocationTokens === undefined ? {} : { allocationTokens }),
  });
}
