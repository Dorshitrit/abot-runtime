import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import {
  resolveRequestModelStepInvoker,
  type ModelStepOutputDiagnostics,
} from "./invoke-step.js";
import { resolveOutputIncompleteError } from "./provider-completion.js";
import type { ModelStepContextCompactionController } from "./model-step-port.js";

export type RawModelValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type RawModelValidationResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{
      ok: false;
      stage: string;
      issues: readonly RawModelValidationIssue[];
      reason: string;
    }>;

export type RawModelRepairHintInput = Readonly<{
  repairAttempt: number;
  stage: string;
  issues: readonly RawModelValidationIssue[];
  repeatedInvalidOutput: boolean;
}>;

/** Carries only bounded validation metadata after raw-output repair is exhausted. */
export class RawModelValidationError extends Error {
  readonly stage: string;
  readonly issues: readonly RawModelValidationIssue[];
  readonly reason: string;

  constructor(
    params: Readonly<{
      stage: string;
      issues: readonly RawModelValidationIssue[];
      reason: string;
    }>,
  ) {
    super(params.reason);
    this.name = "RawModelValidationError";
    this.stage = params.stage;
    this.issues = Object.freeze(
      params.issues.map((issue) => Object.freeze({ ...issue })),
    );
    this.reason = params.reason;
  }
}

/** Invokes one runtime model step whose output contract is exact raw text. */
export async function invokeRawModelStep(params: {
  request: BoundRequestModelInvocationContext;
  modelStep: ModelStep;
  messages: ChatMessage[];
  timeoutReason: string;
  format?: "json" | Record<string, unknown>;
  contextCompaction?: ModelStepContextCompactionController;
}): Promise<string> {
  const modelStepInvoker = resolveRequestModelStepInvoker(params.request);
  return modelStepInvoker.invoke<string>({
    modelStep: params.modelStep,
    messages: params.messages,
    timeoutReason: params.timeoutReason,
    ...(params.format ? { format: params.format } : {}),
    ...(params.contextCompaction
      ? { contextCompaction: params.contextCompaction }
      : {}),
    accept(text, outputDiagnostics) {
      throwIfOutputIncomplete({
        requestId: params.request.requestId,
        modelStep: params.modelStep,
        outputDiagnostics,
      });
      return text;
    },
  });
}

/** Repairs only rejected raw text; provider/runtime failures still propagate. */
export async function invokeRepairableRawModelStep(params: {
  request: BoundRequestModelInvocationContext;
  modelStep: ModelStep;
  messages: ChatMessage[];
  timeoutReason: string;
  format?: "json" | Record<string, unknown>;
  maxRepairAttempts: number;
  contextCompaction?: ModelStepContextCompactionController;
  validate: (
    text: string,
    diagnostics: ModelStepOutputDiagnostics,
  ) => RawModelValidationResult;
  buildRepairHint: (input: RawModelRepairHintInput) => string;
}): Promise<string> {
  const modelStepInvoker = resolveRequestModelStepInvoker(params.request);
  let messages = params.messages;
  let previousRejectedOutput: string | undefined;

  for (
    let repairAttempt = 0;
    repairAttempt <= params.maxRepairAttempts;
    repairAttempt += 1
  ) {
    const finalAttempt = repairAttempt === params.maxRepairAttempts;
    const attempt = await modelStepInvoker.invoke<RawModelAttempt>({
      modelStep: params.modelStep,
      messages,
      timeoutReason: params.timeoutReason,
      ...(params.format ? { format: params.format } : {}),
      ...(params.contextCompaction
        ? { contextCompaction: params.contextCompaction }
        : {}),
      accept(text, outputDiagnostics) {
        throwIfOutputIncomplete({
          requestId: params.request.requestId,
          modelStep: params.modelStep,
          outputDiagnostics,
        });
        const validation = params.validate(text, outputDiagnostics);
        if (validation.ok) {
          return Object.freeze({ ok: true as const, value: validation.value });
        }
        const repeatedInvalidOutput = previousRejectedOutput === text;
        const diagnostic = {
          requestId: params.request.requestId,
          modelStep: params.modelStep,
          validationStage: validation.stage,
          issues: validation.issues.map(({ code, path }) => ({ code, path })),
          issueCount: validation.issues.length,
          repairAttempt,
          maxRepairAttempts: params.maxRepairAttempts,
          repeatedInvalidOutput,
          ...outputDiagnostics,
        };
        traceDebug("runtime.model", "step.invalid_output", diagnostic);
        if (finalAttempt) {
          traceDebug("runtime.model", "step.repair.exhausted", diagnostic);
          throw new RawModelValidationError({
            stage: validation.stage,
            issues: validation.issues,
            reason: validation.reason,
          });
        }
        return Object.freeze({
          ok: false as const,
          validation,
          rejectedOutput: text,
          repeatedInvalidOutput,
        });
      },
    });

    if (attempt.ok) {
      if (repairAttempt > 0) {
        traceDebug("runtime.model", "step.repair.succeeded", {
          requestId: params.request.requestId,
          modelStep: params.modelStep,
          repairAttempts: repairAttempt,
          maxRepairAttempts: params.maxRepairAttempts,
          sameRoleCall: true,
        });
      }
      return attempt.value;
    }

    const repairHint = params.buildRepairHint({
      repairAttempt: repairAttempt + 1,
      stage: attempt.validation.stage,
      issues: attempt.validation.issues,
      repeatedInvalidOutput: attempt.repeatedInvalidOutput,
    });
    traceDebug("runtime.model", "step.repair.started", {
      requestId: params.request.requestId,
      modelStep: params.modelStep,
      repairAttempt: repairAttempt + 1,
      maxRepairAttempts: params.maxRepairAttempts,
      validationStage: attempt.validation.stage,
      issues: attempt.validation.issues.map(({ code, path }) => ({
        code,
        path,
      })),
      issueCount: attempt.validation.issues.length,
      repairHintLength: repairHint.length,
      repeatedInvalidOutput: attempt.repeatedInvalidOutput,
      sameRoleCall: true,
    });
    previousRejectedOutput = attempt.rejectedOutput;
    messages = [
      ...params.messages,
      Object.freeze({ role: "system" as const, content: repairHint }),
    ];
  }

  throw new Error("raw_model_repair_state_invalid");
}

type RawModelAttempt =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{
      ok: false;
      validation: Exclude<RawModelValidationResult, { ok: true }>;
      rejectedOutput: string;
      repeatedInvalidOutput: boolean;
    }>;

function throwIfOutputIncomplete(params: {
  requestId: string;
  modelStep: ModelStep;
  outputDiagnostics: ModelStepOutputDiagnostics;
}): void {
  const error = resolveOutputIncompleteError(params.outputDiagnostics);
  if (!error) {
    return;
  }
  traceDebug("runtime.model", "step.output_incomplete", {
    requestId: params.requestId,
    modelStep: params.modelStep,
    issueCode: error.code,
    validationStage: error.stage,
    ...params.outputDiagnostics,
  });
  throw error;
}
