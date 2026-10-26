import { resolve } from "node:path";
import type { SessionRequestReplay } from "../../sessions/types.js";
import {
  canonicalConfigFilePath,
  ConfigFileConflictError,
  type ConfigFileTransaction,
} from "../../runtime/adapters/config-file-transaction.js";
import { DEFAULT_RUNTIME_CONFIG_FILE } from "../../runtime/config/constants.js";
import { validateModelProfileConfig } from "../../runtime/config/validation.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../config-dashboard-backend.js";
import { withConfigDashboardRootTransaction } from "../config-dashboard-save-transaction.js";
import {
  resolveStepTimeoutTarget,
  timeoutConfigurationRevision,
  type StepTimeoutReceipt,
} from "./step-timeout-target.js";

export class StepTimeoutSuggestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export type StepTimeoutReference = Readonly<{
  environment: string;
  sessionId: string;
  requestId: string;
  invocationId: string;
}>;

export type StepTimeoutServiceOptions = Readonly<{
  rootDir: string;
  configPath?: string;
  getConfigPath?: () => string | undefined;
  getEnvironment: (id: string) => {
    services: {
      sessions: {
        getRequestReplayById: (
          requestId: string,
        ) => Promise<SessionRequestReplay | null>;
      };
    };
  };
  activeReplayForSession?: (
    requestId: string,
    sessionId: string,
    environment: string,
  ) => readonly Record<string, unknown>[] | undefined;
}>;

function requireReferenceString(
  input: Record<string, unknown>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new StepTimeoutSuggestionError(
      "invalid_timeout_reference",
      `A valid ${field} is required.`,
    );
  return value;
}

function readTimeoutReference(
  input: Record<string, unknown>,
): StepTimeoutReference {
  const allowed = [
    "environment",
    "sessionId",
    "requestId",
    "invocationId",
    "expectedRevision",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new StepTimeoutSuggestionError(
      "invalid_timeout_reference",
      "Timeout updates accept only an observed invocation reference.",
    );
  return {
    environment: requireReferenceString(input, "environment"),
    sessionId: requireReferenceString(input, "sessionId"),
    requestId: requireReferenceString(input, "requestId"),
    invocationId: requireReferenceString(input, "invocationId"),
  };
}

function isTimeoutReceipt(
  event: Record<string, unknown>,
  reference: StepTimeoutReference,
): boolean {
  if (event.name !== "model.step.timed_out") return false;
  if (
    event.requestId !== reference.requestId ||
    event.invocationId !== reference.invocationId
  )
    return false;
  if (
    !["modelStep", "profileId", "model", "provider"].every(
      (key) => typeof event[key] === "string" && event[key],
    )
  )
    return false;
  if (
    !["timeoutMs", "configuredTimeoutMs"].every(
      (key) => Number.isSafeInteger(event[key]) && Number(event[key]) > 0,
    )
  )
    return false;
  if (
    event.timeoutSource !== "runner" &&
    event.timeoutSource !== "model_calibration"
  )
    return false;
  if (
    event.configurationProfileId !== undefined &&
    typeof event.configurationProfileId !== "string"
  )
    return false;
  if (
    event.calibrationSlotId !== undefined &&
    typeof event.calibrationSlotId !== "string"
  )
    return false;
  return true;
}

function validateTimeoutCandidate(candidate: Record<string, unknown>): void {
  const issues: string[] = [];
  validateModelProfileConfig(issues, candidate, "model profile", {
    allowConfigRef: false,
  });
  if (issues.length)
    throw new StepTimeoutSuggestionError(
      "invalid_timeout_configuration",
      "The model configuration needs correction in Settings before this timeout can be changed.",
      409,
    );
}

export class StepTimeoutService {
  constructor(private readonly options: StepTimeoutServiceOptions) {}

  private async observedTimeout(
    reference: StepTimeoutReference,
  ): Promise<StepTimeoutReceipt> {
    const active = this.options.activeReplayForSession?.(
      reference.requestId,
      reference.sessionId,
      reference.environment,
    );
    const current = active?.find((event) => isTimeoutReceipt(event, reference));
    if (current) return current as StepTimeoutReceipt;
    const replay = await this.options
      .getEnvironment(reference.environment)
      .services.sessions.getRequestReplayById(reference.requestId);
    if (
      replay?.sessionId !== reference.sessionId ||
      replay.requestId !== reference.requestId
    )
      throw new StepTimeoutSuggestionError(
        "timeout_not_found",
        "This timeout is no longer available for the selected conversation.",
        404,
      );
    const event = replay.events.find((entry) =>
      isTimeoutReceipt(entry, reference),
    );
    if (!event)
      throw new StepTimeoutSuggestionError(
        "timeout_not_found",
        "No model step timeout was recorded for this invocation.",
        404,
      );
    return event as StepTimeoutReceipt;
  }

  private async configuration<T>(
    operation: (
      snapshot: Awaited<ReturnType<typeof getConfigDashboardSnapshot>>,
      transaction: ConfigFileTransaction,
      configPath: string,
    ) => Promise<T>,
  ): Promise<T> {
    const configPath = resolve(
      this.options.rootDir,
      this.options.getConfigPath?.() ??
        this.options.configPath ??
        DEFAULT_RUNTIME_CONFIG_FILE,
    );
    const canonicalPath = await canonicalConfigFilePath(configPath);
    return withConfigDashboardRootTransaction(
      canonicalPath,
      undefined,
      async (transaction) => {
        const snapshot = await getConfigDashboardSnapshot(
          { rootDir: this.options.rootDir, configPath },
          transaction.snapshot,
        );
        return operation(snapshot, transaction, configPath);
      },
    );
  }

  async inspect(input: Record<string, unknown>) {
    const receipt = await this.observedTimeout(readTimeoutReference(input));
    return this.configuration(async (snapshot) => ({
      suggestion: (await resolveStepTimeoutTarget(snapshot, receipt))
        .suggestion,
    }));
  }

  async increase(input: Record<string, unknown>) {
    const reference = readTimeoutReference(input);
    const expectedRevision = input.expectedRevision;
    if (
      typeof expectedRevision !== "string" ||
      !/^[a-f0-9]{64}\.[a-f0-9]{64}$/u.test(expectedRevision)
    )
      throw new StepTimeoutSuggestionError(
        "config_revision_required",
        "Reload the timeout suggestion before saving it.",
        428,
      );
    const receipt = await this.observedTimeout(reference);
    return this.configuration(async (snapshot, transaction, configPath) => {
      const target = await resolveStepTimeoutTarget(snapshot, receipt);
      const { suggestion, file, candidate } = target;
      if (!file || !candidate)
        throw new StepTimeoutSuggestionError(
          suggestion.reason ?? "timeout_target_changed",
          "The timeout target changed or requires a manual update in Model settings.",
          409,
        );
      const [beforeRevision, afterRevision] = expectedRevision.split(".");
      const currentRevision = timeoutConfigurationRevision(snapshot);
      const isExactSavedCandidate =
        currentRevision === afterRevision &&
        target.currentTimeoutMs === suggestion.proposedTimeoutMs;
      if (isExactSavedCandidate)
        return {
          status: "already_saved" as const,
          timeoutMs: suggestion.proposedTimeoutMs,
          restartRequired: true,
        };
      if (currentRevision !== beforeRevision || !suggestion.canIncrease)
        throw new ConfigFileConflictError();
      if (suggestion.revision !== expectedRevision)
        throw new ConfigFileConflictError();
      validateTimeoutCandidate(candidate);
      await saveConfigDashboardFile({
        rootDir: this.options.rootDir,
        configPath,
        kind: "model",
        id: file.id,
        config: candidate,
        expectedRevision: file.revision,
        transaction,
      });
      return {
        status: "saved" as const,
        timeoutMs: suggestion.proposedTimeoutMs,
        restartRequired: true,
      };
    });
  }
}
