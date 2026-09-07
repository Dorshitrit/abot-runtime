import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { traceDebug } from "../observability/debug-logger.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";
import { resolveRequestModelStepInvoker } from "./invoke-step.js";
import type { ModelStepContextCompactionController } from "./model-step-port.js";
import { resolveOutputIncompleteError } from "./provider-completion.js";
import {
  STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
  buildStructuredModelRepairHint,
} from "./repair-prompts.js";

export type StructuredModelValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type StructuredModelParseResult<T> =
  | Readonly<{ ok: true; decision: T }>
  | Readonly<{
      ok: false;
      stage: string;
      issues: readonly StructuredModelValidationIssue[];
    }>;

/** Distinguishes repairable model output from provider/runtime failures. */
export class StructuredModelInvalidOutputError extends Error {
  readonly modelStep: ModelStep;
  readonly validationStage: string;
  readonly issues: readonly StructuredModelValidationIssue[];
  readonly repairAttempts: number;
  readonly repeatedInvalidOutput: boolean;

  constructor(
    reason: string,
    modelStep: ModelStep,
    details: Readonly<{
      validationStage: string;
      issues: readonly StructuredModelValidationIssue[];
      repairAttempts: number;
      repeatedInvalidOutput: boolean;
    }>,
  ) {
    super(reason);
    this.name = "StructuredModelInvalidOutputError";
    this.modelStep = modelStep;
    this.validationStage = details.validationStage;
    this.issues = Object.freeze([...details.issues]);
    this.repairAttempts = details.repairAttempts;
    this.repeatedInvalidOutput = details.repeatedInvalidOutput;
  }
}

export async function invokeStructuredModelStep<T>(params: {
  request: BoundRequestModelInvocationContext;
  modelStep: ModelStep;
  format: ModelGatewayJsonSchemaFormat;
  messages: ChatMessage[];
  timeoutReason: string;
  boundSteeringVersion?: number;
  invalidOutputReason: string;
  contextCompaction?: ModelStepContextCompactionController;
  parse: (text: string) => StructuredModelParseResult<T>;
}): Promise<T> {
  const modelStepInvoker = resolveRequestModelStepInvoker(params.request);
  let messages = params.messages;
  let previousRejectedOutput: string | undefined;

  for (
    let repairAttempt = 0;
    repairAttempt <= STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS;
    repairAttempt += 1
  ) {
    const finalAttempt = repairAttempt === STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS;
    const attempt = await modelStepInvoker.invoke<StructuredModelAttempt<T>>({
      modelStep: params.modelStep,
      messages,
      timeoutReason: params.timeoutReason,
      boundSteeringVersion: params.boundSteeringVersion,
      format: params.format,
      ...(params.contextCompaction
        ? { contextCompaction: params.contextCompaction }
        : {}),
      accept(text, outputDiagnostics) {
        const incompleteError = resolveOutputIncompleteError(outputDiagnostics);
        if (incompleteError) {
          traceDebug("runtime.model", "step.output_incomplete", {
            requestId: params.request.requestId,
            modelStep: params.modelStep,
            issueCode: incompleteError.code,
            validationStage: incompleteError.stage,
            ...outputDiagnostics,
          });
          throw incompleteError;
        }
        const parsed = params.parse(text);
        if (parsed.ok) {
          return Object.freeze({ ok: true as const, value: parsed.decision });
        }
        const repeatedInvalidOutput = previousRejectedOutput === text;
        const diagnostic = {
          requestId: params.request.requestId,
          modelStep: params.modelStep,
          validationStage: parsed.stage,
          issues: projectIssues(parsed.issues),
          issueCount: parsed.issues.length,
          outputKind: classifyStructuredOutput(text),
          repairAttempt,
          maxRepairAttempts: STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
          repeatedInvalidOutput,
          ...outputDiagnostics,
        };
        traceDebug("runtime.model", "step.invalid_output", diagnostic);
        const error = new StructuredModelInvalidOutputError(
          params.invalidOutputReason,
          params.modelStep,
          {
            validationStage: parsed.stage,
            issues: parsed.issues,
            repairAttempts: repairAttempt,
            repeatedInvalidOutput,
          },
        );
        if (finalAttempt) {
          traceDebug("runtime.model", "step.repair.exhausted", diagnostic);
          throw error;
        }
        return Object.freeze({
          ok: false as const,
          error,
          rejectedOutput: text,
        });
      },
    });

    if (attempt.ok) {
      if (repairAttempt > 0) {
        traceDebug("runtime.model", "step.repair.succeeded", {
          requestId: params.request.requestId,
          modelStep: params.modelStep,
          repairAttempts: repairAttempt,
          maxRepairAttempts: STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
          sameRoleCall: true,
        });
      }
      return attempt.value;
    }

    const repairHint = buildStructuredModelRepairHint({
      repairAttempt: repairAttempt + 1,
      stage: attempt.error.validationStage,
      issues: attempt.error.issues,
      repeatedInvalidOutput: attempt.error.repeatedInvalidOutput,
    });
    traceDebug("runtime.model", "step.repair.started", {
      requestId: params.request.requestId,
      modelStep: params.modelStep,
      repairAttempt: repairAttempt + 1,
      maxRepairAttempts: STRUCTURED_MODEL_MAX_REPAIR_ATTEMPTS,
      validationStage: attempt.error.validationStage,
      issues: projectIssues(attempt.error.issues),
      issueCount: attempt.error.issues.length,
      repairHintLength: repairHint.length,
      repeatedInvalidOutput: attempt.error.repeatedInvalidOutput,
      sameRoleCall: true,
    });
    previousRejectedOutput = attempt.rejectedOutput;
    messages = [
      ...params.messages,
      Object.freeze({ role: "system" as const, content: repairHint }),
    ];
  }

  throw new Error("structured_model_repair_state_invalid");
}

type StructuredModelAttempt<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      error: StructuredModelInvalidOutputError;
      rejectedOutput: string;
    }>;

function projectIssues(
  issues: readonly StructuredModelValidationIssue[],
): readonly Readonly<{ code: string; path: string }>[] {
  return issues.map(({ code, path }) => Object.freeze({ code, path }));
}

function classifyStructuredOutput(
  text: string,
): "empty" | "json_object" | "json_array" | "json_scalar" | "non_json" {
  const normalized = text.trim();
  if (!normalized) {
    return "empty";
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(normalized) as unknown;
  } catch {
    return "non_json";
  }
  if (Array.isArray(decoded)) {
    return "json_array";
  }
  if (decoded !== null && typeof decoded === "object") {
    return "json_object";
  }
  return "json_scalar";
}
