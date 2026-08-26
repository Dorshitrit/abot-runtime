import {
  isRoleCapabilityId,
  ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH,
  ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX,
  ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH,
  ROLE_CAPABILITY_EXECUTION_LIMIT_MAX,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type ExecutionPolicyCapabilityAuthority,
  type RoleCallFrame,
} from "../role-calls/index.js";
import { normalizeCapabilityAdapterResult } from "../capability-adapters/result.js";
import {
  traceWorkerCapabilityPayloadCompleted,
  traceWorkerCapabilityPayloadFailed,
  traceWorkerCapabilityPayloadStarted,
  type WorkerCapabilityPayloadDiagnosticContext,
} from "./payload-diagnostics.js";
import {
  WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
  WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS,
  WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT,
  WorkerCapabilityPayloadBudgetExceededError,
  WorkerCapabilityPayloadValidationError,
  type WorkerCapabilityPayloadAuthor,
  type WorkerCapabilityPayloadAuthoringResult,
  type WorkerCapabilityPayloadContext,
  type WorkerCapabilityPayloadContextScope,
  type WorkerCapabilityPayloadModelPort,
} from "./payload-contracts.js";
import {
  ROOT_CAPABILITY_PAYLOAD_INSTRUCTIONS,
  ROOT_CAPABILITY_STAGED_RAW_PAYLOAD_INSTRUCTIONS,
  ROOT_CAPABILITY_STRUCTURED_PAYLOAD_INSTRUCTIONS,
  WORKER_CAPABILITY_PAYLOAD_INSTRUCTIONS,
  WORKER_CAPABILITY_STAGED_RAW_PAYLOAD_INSTRUCTIONS,
  WORKER_CAPABILITY_STRUCTURED_PAYLOAD_INSTRUCTIONS,
} from "./payload-instructions.js";
import { validateJsonSchemaValue } from "../../model/json-schema-value.js";
import { isRuntimeDelegateRoleId } from "../roles.js";

type PayloadAuthorInput = Parameters<
  WorkerCapabilityPayloadAuthor["author"]
>[0];

type PayloadPrincipal =
  | Readonly<{
      kind: "worker";
      context: Readonly<{
        callId: string;
        parentCallId: string;
        invocationAttempt: number;
        objective: string;
      }>;
    }>
  | Readonly<{
      kind: "root";
      context: Readonly<{
        callId: string;
        invocationAttempt: number;
        objectiveSource: "runtime_request_source_plus_steering_v1";
      }>;
    }>;

type RootRequestSteering = Readonly<{
  version: number;
  updates: readonly Readonly<{ sequence: number; text: string }>[];
}>;

export function createWorkerCapabilityPayloadAuthor(params: {
  requestId: string;
  abortSignal: AbortSignal;
  model?: WorkerCapabilityPayloadModelPort;
  capabilityAuthorities?: readonly ExecutionPolicyCapabilityAuthority[];
}): WorkerCapabilityPayloadAuthor {
  const capabilityAuthorities = Object.freeze([
    ...(params.capabilityAuthorities ?? (["worker"] as const)),
  ]);
  return Object.freeze({
    async author(input) {
      const baseDiagnostic: WorkerCapabilityPayloadDiagnosticContext =
        Object.freeze({
          requestId: params.requestId,
          call: input.call,
          executionId: input.executionId,
          descriptor: input.descriptor,
          controlCount: Object.keys(input.controls).length,
          minBytes: input.contract.minBytes,
          maxBytes: input.contract.maxBytes,
          settledCapabilityResultCount: 0,
          settledCapabilitySummaryLength: 0,
          settledCapabilityReferenceDataLength: 0,
          payloadContextCharacterCount: 0,
          relatedArtifactContextCount:
            input.relatedArtifactContexts?.length ?? 0,
          relatedArtifactContextCharacterCount:
            input.relatedArtifactContexts?.reduce(
              (total, artifact) => total + artifact.content.length,
              0,
            ) ?? 0,
          ...(input.relatedArtifactContexts &&
          input.relatedArtifactContexts.length > 0
            ? {
                relatedArtifactContextTransport: "verbatim_reference" as const,
              }
            : {}),
          ...(input.stage
            ? {
                payloadStage: input.stage.index,
                payloadStageCount: input.stage.count,
                payloadOutputParam: input.stage.outputParam,
                payloadResponseFormat: classifyResponseFormat(
                  input.contract.responseFormat,
                ),
                materializedParamCount: Object.keys(
                  input.materializedParams ?? {},
                ).length,
                targetContextCharacterCount:
                  input.targetContext?.content.length ?? 0,
                ...(input.targetContext
                  ? {
                      targetContextPresentation:
                        input.targetContext.presentation,
                      ...(input.targetContext.sourceRange
                        ? {
                            targetContextWritableStartLine:
                              input.targetContext.sourceRange.writableStartLine,
                            targetContextWritableEndLine:
                              input.targetContext.sourceRange.writableEndLine,
                            targetContextWindowStartLine:
                              input.targetContext.sourceRange.contextStartLine,
                            targetContextWindowEndLine:
                              input.targetContext.sourceRange.contextEndLine,
                          }
                        : {}),
                    }
                  : {}),
                ...(input.targetContext
                  ? {
                      targetContextTransport: "verbatim_reference" as const,
                    }
                  : {}),
              }
            : {}),
        });
      const context = capturePayloadContext(input, capabilityAuthorities);
      if (!context) {
        return failure(baseDiagnostic, "payload_context_invalid");
      }
      const diagnostic: WorkerCapabilityPayloadDiagnosticContext =
        Object.freeze({
          ...baseDiagnostic,
          settledCapabilityResultCount: context.settledCapabilityResults.length,
          settledCapabilitySummaryLength:
            context.settledCapabilityResults.reduce(
              (total, result) => total + result.summary.length,
              0,
            ),
          settledCapabilityReferenceDataLength:
            context.settledCapabilityResults.reduce(
              (total, result) => total + (result.referenceData?.length ?? 0),
              0,
            ),
          payloadContextCharacterCount: JSON.stringify(context).length,
        });
      traceWorkerCapabilityPayloadStarted(diagnostic);
      if (!params.model) {
        return failure(diagnostic, "payload_model_unavailable");
      }

      let output: unknown;
      try {
        output = await params.model.invoke({
          executionId: input.executionId,
          modelStep: WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
          instructions: payloadInstructions(input, context),
          context,
          ...(input.contract.responseFormat
            ? { responseFormat: input.contract.responseFormat }
            : {}),
        });
      } catch (error: unknown) {
        if (params.abortSignal.aborted) {
          throw payloadAbort(params.abortSignal.reason);
        }
        if (error instanceof WorkerCapabilityPayloadBudgetExceededError) {
          return failure(diagnostic, "payload_context_budget_exceeded");
        }
        if (error instanceof WorkerCapabilityPayloadValidationError) {
          return failure(diagnostic, error.code);
        }
        return failure(diagnostic, "payload_model_invocation_failed", error);
      }
      if (typeof output !== "string") {
        return failure(diagnostic, "payload_model_output_invalid");
      }
      const body = normalizeAuthoredBody(output, input.contract.responseFormat);
      if (body === undefined) {
        return failure(diagnostic, "payload_model_output_invalid");
      }
      const payloadBytes = Buffer.byteLength(body, "utf8");
      if (payloadBytes < input.contract.minBytes) {
        return failure(diagnostic, "payload_body_too_small");
      }
      if (payloadBytes > input.contract.maxBytes) {
        return failure(diagnostic, "payload_body_too_large");
      }
      traceWorkerCapabilityPayloadCompleted(diagnostic, payloadBytes);
      return Object.freeze({ status: "authored" as const, body });
    },
  });
}

function capturePayloadContext(
  input: PayloadAuthorInput,
  capabilityAuthorities: readonly ExecutionPolicyCapabilityAuthority[],
): WorkerCapabilityPayloadContext | null {
  const contextScope = normalizePayloadContextScope(
    input.contextScope ?? input.stage?.contextScope,
  );
  const principal = capturePayloadPrincipal(input.call, capabilityAuthorities);
  const requestSteering = normalizeRootRequestSteering(input.requestSteering);
  if (
    !principal ||
    !payloadPrincipalMatchesSteering(
      principal,
      input.requestSteering,
      requestSteering,
    ) ||
    !validPayloadAssignment(input) ||
    !validPayloadContract(input.contract) ||
    !validPayloadStageContract(input, contextScope) ||
    !validPayloadEvidenceContext(input, contextScope) ||
    !validStageOwnedPayloadInputs(input) ||
    !validDependencyResults(input.dependencyResults, input.call) ||
    !validSettledCapabilityResults(
      input.settledCapabilityResults,
      input.call,
      input.executionId,
    )
  ) {
    return null;
  }
  // `validPayloadStageContract` rejects this case; the explicit guard carries
  // that invariant into TypeScript's control-flow analysis.
  if (contextScope === undefined) {
    return null;
  }
  const sharedContext = {
    acceptedCapability: {
      capabilityId: input.descriptor.capabilityId,
      summary: input.descriptor.summary,
      controls: input.controls,
    },
    contextScope,
    ...(input.dependencyResults
      ? { dependencyResults: input.dependencyResults }
      : {}),
    settledCapabilityResults: input.settledCapabilityResults,
    payloadContract: {
      instructions: input.contract.instructions,
      minBytes: input.contract.minBytes,
      maxBytes: input.contract.maxBytes,
      ...(input.contract.responseFormat
        ? { responseFormat: input.contract.responseFormat }
        : {}),
    },
    ...(input.stage ? { payloadStage: input.stage } : {}),
    ...(input.materializedParams
      ? { materializedParams: input.materializedParams }
      : {}),
    ...(input.targetContext ? { targetContext: input.targetContext } : {}),
    ...(input.relatedArtifactContexts
      ? { relatedArtifactContexts: input.relatedArtifactContexts }
      : {}),
  };
  return principal.kind === "worker"
    ? immutableSnapshot({ worker: principal.context, ...sharedContext })
    : immutableSnapshot({
        root: {
          ...principal.context,
          steeringVersion: requestSteering!.version,
          updates: requestSteering!.updates,
        },
        ...sharedContext,
      });
}

function payloadPrincipalMatchesSteering(
  principal: PayloadPrincipal,
  input: PayloadAuthorInput["requestSteering"],
  normalized: RootRequestSteering | undefined,
): boolean {
  return principal.kind === "root"
    ? normalized !== undefined
    : input === undefined;
}

function validPayloadAssignment(input: PayloadAuthorInput): boolean {
  return typeof input.executionId === "string" && input.executionId.length > 0;
}

function validPayloadContract(input: PayloadAuthorInput["contract"]): boolean {
  return (
    typeof input.instructions === "string" &&
    input.instructions.trim().length > 0 &&
    Number.isSafeInteger(input.minBytes) &&
    input.minBytes >= 0 &&
    Number.isSafeInteger(input.maxBytes) &&
    input.maxBytes >= 1 &&
    input.minBytes <= input.maxBytes &&
    validResponseFormat(input.responseFormat)
  );
}

function validPayloadStageContract(
  input: PayloadAuthorInput,
  contextScope: WorkerCapabilityPayloadContextScope | undefined,
): boolean {
  if (contextScope === undefined || !validPayloadStage(input.stage)) {
    return false;
  }
  if (
    input.contextScope !== undefined &&
    input.stage?.contextScope !== undefined &&
    input.stage.contextScope !== input.contextScope
  ) {
    return false;
  }
  return true;
}

function validPayloadEvidenceContext(
  input: PayloadAuthorInput,
  contextScope: WorkerCapabilityPayloadContextScope | undefined,
): boolean {
  if (
    !validMaterializedParams(input.materializedParams) ||
    !validTargetContext(input.targetContext) ||
    !validRelatedArtifactContexts(input.relatedArtifactContexts)
  ) {
    return false;
  }
  const hasRelatedArtifacts = (input.relatedArtifactContexts?.length ?? 0) > 0;
  return !hasRelatedArtifacts || contextScope === "target_with_artifacts";
}

function validStageOwnedPayloadInputs(input: PayloadAuthorInput): boolean {
  const hasStageOwnedInput =
    input.materializedParams !== undefined ||
    input.targetContext !== undefined ||
    input.contract.responseFormat !== undefined;
  return !hasStageOwnedInput || input.stage !== undefined;
}

function validDependencyResults(
  results: PayloadAuthorInput["dependencyResults"],
  call: RoleCallFrame,
): boolean {
  const projected = results ?? [];
  if (
    !Array.isArray(projected) ||
    projected.length !== call.dependencyResultRefs.length
  ) {
    return false;
  }
  return projected.every((candidate, index) => {
    if (!isObjectRecord(candidate)) return false;
    const keys = Object.keys(candidate);
    const semanticCheckpoints = candidate.semanticCheckpoints;
    return (
      keys.length >= 5 &&
      keys.length <= 6 &&
      keys.every(
        (key) =>
          key === "resultRef" ||
          key === "producerCallId" ||
          key === "roleId" ||
          key === "outcome" ||
          key === "summary" ||
          key === "semanticCheckpoints",
      ) &&
      candidate.resultRef === call.dependencyResultRefs[index] &&
      typeof candidate.producerCallId === "string" &&
      candidate.producerCallId.length > 0 &&
      isRuntimeDelegateRoleId(candidate.roleId) &&
      (candidate.outcome === "completed" || candidate.outcome === "failed") &&
      typeof candidate.summary === "string" &&
      candidate.summary.trim().length > 0 &&
      candidate.summary.length <= ROLE_CALL_RESULT_MAX_LENGTH &&
      (semanticCheckpoints === undefined ||
        (Array.isArray(semanticCheckpoints) &&
          semanticCheckpoints.length > 0 &&
          semanticCheckpoints.every(
            (checkpoint) =>
              isObjectRecord(checkpoint) &&
              checkpoint.kind === "runtime_semantic_compaction_checkpoint_v2",
          )))
    );
  });
}

function normalizeRootRequestSteering(
  input: PayloadAuthorInput["requestSteering"],
): RootRequestSteering | undefined {
  if (
    input === undefined ||
    input.kind !== "request_steering_v1" ||
    !Number.isSafeInteger(input.version) ||
    input.version < 0 ||
    !Array.isArray(input.updates) ||
    input.updates.length !== input.version ||
    input.updates.some(
      (update, index) =>
        typeof update !== "object" ||
        update === null ||
        update.sequence !== index + 1 ||
        typeof update.text !== "string" ||
        update.text.trim().length === 0,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    version: input.version,
    updates: Object.freeze(
      input.updates.map(({ sequence, text }) =>
        Object.freeze({ sequence, text }),
      ),
    ),
  });
}

function capturePayloadPrincipal(
  call: RoleCallFrame,
  capabilityAuthorities: readonly ExecutionPolicyCapabilityAuthority[],
): PayloadPrincipal | null {
  if (capabilityAuthorities.includes("worker") && validWorkerCall(call)) {
    return {
      kind: "worker",
      context: {
        callId: call.callId,
        parentCallId: call.parentCallId,
        invocationAttempt: call.activationCount,
        objective: call.objective,
      },
    };
  }
  if (capabilityAuthorities.includes("root") && validCanonicalRootCall(call)) {
    return {
      kind: "root",
      context: {
        callId: call.callId,
        invocationAttempt: call.activationCount,
        objectiveSource: "runtime_request_source_plus_steering_v1",
      },
    };
  }
  return null;
}

function payloadInstructions(
  input: Parameters<WorkerCapabilityPayloadAuthor["author"]>[0],
  context: WorkerCapabilityPayloadContext,
): string {
  if ("worker" in context) {
    return input.contract.responseFormat
      ? WORKER_CAPABILITY_STRUCTURED_PAYLOAD_INSTRUCTIONS
      : input.stage
        ? WORKER_CAPABILITY_STAGED_RAW_PAYLOAD_INSTRUCTIONS
        : WORKER_CAPABILITY_PAYLOAD_INSTRUCTIONS;
  }
  return input.contract.responseFormat
    ? ROOT_CAPABILITY_STRUCTURED_PAYLOAD_INSTRUCTIONS
    : input.stage
      ? ROOT_CAPABILITY_STAGED_RAW_PAYLOAD_INSTRUCTIONS
      : ROOT_CAPABILITY_PAYLOAD_INSTRUCTIONS;
}

function normalizePayloadContextScope(
  input: Parameters<WorkerCapabilityPayloadAuthor["author"]>[0]["contextScope"],
): WorkerCapabilityPayloadContextScope | undefined {
  if (input === undefined) return "standard";
  return input === "standard" ||
    input === "target_only" ||
    input === "target_with_artifacts"
    ? input
    : undefined;
}

function normalizeAuthoredBody(
  output: string,
  responseFormat:
    | Parameters<
        WorkerCapabilityPayloadAuthor["author"]
      >[0]["contract"]["responseFormat"]
    | undefined,
): string | undefined {
  if (!responseFormat) {
    return output;
  }
  try {
    const parsed = JSON.parse(output);
    if (
      responseFormat !== "json" &&
      validateJsonSchemaValue(responseFormat, parsed)
    ) {
      return undefined;
    }
    return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
}

function validResponseFormat(
  input:
    | Parameters<
        WorkerCapabilityPayloadAuthor["author"]
      >[0]["contract"]["responseFormat"]
    | undefined,
): boolean {
  return input === undefined || input === "json" || isPlainRecord(input);
}

function validPayloadStage(
  input: Parameters<WorkerCapabilityPayloadAuthor["author"]>[0]["stage"],
): boolean {
  return (
    input === undefined ||
    (Number.isSafeInteger(input.index) &&
      input.index > 0 &&
      Number.isSafeInteger(input.count) &&
      input.count > 1 &&
      input.index <= input.count &&
      typeof input.outputParam === "string" &&
      input.outputParam.trim().length > 0 &&
      (input.contextScope === undefined ||
        normalizePayloadContextScope(input.contextScope) !== undefined))
  );
}

function validMaterializedParams(
  input: Parameters<
    WorkerCapabilityPayloadAuthor["author"]
  >[0]["materializedParams"],
): boolean {
  return (
    input === undefined ||
    (isPlainRecord(input) &&
      Object.entries(input).every(
        ([name, value]) => name.trim().length > 0 && typeof value === "string",
      ))
  );
}

function validTargetContext(
  input: Parameters<
    WorkerCapabilityPayloadAuthor["author"]
  >[0]["targetContext"],
): boolean {
  return (
    input === undefined ||
    (typeof input.targetParam === "string" &&
      input.targetParam.trim().length > 0 &&
      typeof input.targetPath === "string" &&
      input.targetPath.trim().length > 0 &&
      (input.presentation === "bounded" ||
        input.presentation === "full" ||
        input.presentation === "full_numbered") &&
      typeof input.content === "string" &&
      validTargetSourceRange(input))
  );
}

function validRelatedArtifactContexts(
  input: Parameters<
    WorkerCapabilityPayloadAuthor["author"]
  >[0]["relatedArtifactContexts"],
): boolean {
  if (input === undefined) return true;
  if (
    !Array.isArray(input) ||
    input.length > WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT
  ) {
    return false;
  }
  const paths = new Set<string>();
  let totalCharacters = 0;
  return input.every((artifact) => {
    if (
      !isPlainRecord(artifact) ||
      typeof artifact.sourceExecutionId !== "string" ||
      artifact.sourceExecutionId.trim().length === 0 ||
      typeof artifact.targetPath !== "string" ||
      artifact.targetPath.trim().length === 0 ||
      artifact.targetPath.length >
        ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH ||
      artifact.presentation !== "full" ||
      typeof artifact.content !== "string" ||
      (totalCharacters += artifact.content.length) >
        WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS ||
      paths.has(artifact.targetPath)
    ) {
      return false;
    }
    paths.add(artifact.targetPath);
    return true;
  });
}

function validTargetSourceRange(
  input: NonNullable<
    Parameters<WorkerCapabilityPayloadAuthor["author"]>[0]["targetContext"]
  >,
): boolean {
  if (input.presentation !== "bounded") {
    return input.sourceRange === undefined;
  }
  const range = input.sourceRange;
  return (
    range !== undefined &&
    [
      range.contextStartLine,
      range.contextEndLine,
      range.writableStartLine,
      range.writableEndLine,
      range.totalLines,
    ].every((value) => Number.isInteger(value) && value > 0) &&
    range.contextStartLine <= range.writableStartLine &&
    range.writableStartLine <= range.writableEndLine &&
    range.writableEndLine <= range.contextEndLine &&
    range.contextEndLine <= range.totalLines
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function classifyResponseFormat(
  input:
    | Parameters<
        WorkerCapabilityPayloadAuthor["author"]
      >[0]["contract"]["responseFormat"]
    | undefined,
): "raw" | "json" | "schema" {
  return input === undefined ? "raw" : input === "json" ? "json" : "schema";
}

function validSettledCapabilityResults(
  results: readonly unknown[],
  call: RoleCallFrame,
  currentExecutionId: string,
): boolean {
  if (
    !Array.isArray(results) ||
    results.length > ROLE_CAPABILITY_EXECUTION_LIMIT_MAX
  ) {
    return false;
  }
  let previousInvocationAttempt = 0;
  return results.every((candidate) => {
    if (!isObjectRecord(candidate)) {
      return false;
    }
    if (
      !validSettledCapabilityResultShape(candidate) ||
      !validSettledCapabilityResultIdentity({
        result: candidate,
        call,
        currentExecutionId,
        previousInvocationAttempt,
      }) ||
      !validSettledCapabilityOutcome(candidate) ||
      !validSettledCapabilityEvidence(candidate)
    ) {
      return false;
    }
    previousInvocationAttempt = candidate.invocationAttempt as number;
    return true;
  });
}

const SETTLED_CAPABILITY_RESULT_KEYS: ReadonlySet<string> = new Set([
  "executionId",
  "callId",
  "invocationAttempt",
  "capabilityId",
  "declaredEffect",
  "outcome",
  "observedEffect",
  "summary",
  "referenceData",
  "references",
  "adapterResult",
]);

function validSettledCapabilityResultShape(
  result: Record<string, unknown>,
): boolean {
  const keys = Object.keys(result);
  return (
    keys.length >= 8 &&
    keys.length <= 11 &&
    keys.every((key) => SETTLED_CAPABILITY_RESULT_KEYS.has(key))
  );
}

function validSettledCapabilityResultIdentity(params: {
  result: Record<string, unknown>;
  call: RoleCallFrame;
  currentExecutionId: string;
  previousInvocationAttempt: number;
}): boolean {
  const { result } = params;
  return (
    typeof result.executionId === "string" &&
    result.executionId.length > 0 &&
    result.executionId !== params.currentExecutionId &&
    result.callId === params.call.callId &&
    Number.isSafeInteger(result.invocationAttempt) &&
    (result.invocationAttempt as number) >= params.previousInvocationAttempt &&
    (result.invocationAttempt as number) < params.call.activationCount &&
    isRoleCapabilityId(result.capabilityId)
  );
}

function validSettledCapabilityOutcome(
  result: Record<string, unknown>,
): boolean {
  return (
    (result.declaredEffect === "observation" ||
      result.declaredEffect === "mutation" ||
      result.declaredEffect === "mixed") &&
    (result.outcome === "succeeded" || result.outcome === "failed") &&
    (result.observedEffect === "none" ||
      result.observedEffect === "observation" ||
      result.observedEffect === "mutation" ||
      result.observedEffect === "indeterminate")
  );
}

function validSettledCapabilityEvidence(
  result: Record<string, unknown>,
): boolean {
  return (
    typeof result.summary === "string" &&
    result.summary.trim().length > 0 &&
    result.summary.length <= ROLE_CALL_RESULT_MAX_LENGTH &&
    (result.referenceData === undefined ||
      (typeof result.referenceData === "string" &&
        result.referenceData.trim().length > 0 &&
        result.referenceData.length <=
          ROLE_CAPABILITY_REFERENCE_DATA_MAX_LENGTH)) &&
    validResultReferences(result.references) &&
    normalizeCapabilityAdapterResult(result.adapterResult).ok
  );
}

function validResultReferences(input: unknown): boolean {
  if (input === undefined) return true;
  if (
    !Array.isArray(input) ||
    input.length > ROLE_CAPABILITY_RESULT_REFERENCE_LIMIT_MAX
  ) {
    return false;
  }
  const targets = new Set<string>();
  for (const candidate of input) {
    if (
      !isPlainRecord(candidate) ||
      Object.keys(candidate).length !== 2 ||
      candidate.kind !== "tool_target" ||
      typeof candidate.target !== "string" ||
      candidate.target.trim().length === 0 ||
      candidate.target.length >
        ROLE_CAPABILITY_RESULT_REFERENCE_TARGET_MAX_LENGTH ||
      targets.has(candidate.target)
    ) {
      return false;
    }
    targets.add(candidate.target);
  }
  return true;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validWorkerCall(
  call: RoleCallFrame,
): call is RoleCallFrame &
  Readonly<{ parentCallId: string; objective: string }> {
  return (
    call.roleId === "worker" &&
    typeof call.parentCallId === "string" &&
    call.parentCallId.length > 0 &&
    typeof call.objective === "string" &&
    call.objective.length > 0 &&
    Number.isSafeInteger(call.activationCount) &&
    call.activationCount > 0
  );
}

function validCanonicalRootCall(call: RoleCallFrame): boolean {
  return (
    call.roleId === "supervisor" &&
    typeof call.callId === "string" &&
    call.callId.length > 0 &&
    call.parentCallId === null &&
    call.depth === 0 &&
    call.objective === null &&
    call.status === "active" &&
    Number.isSafeInteger(call.activationCount) &&
    call.activationCount > 0 &&
    call.resultRef === null
  );
}

function failure(
  diagnostic: WorkerCapabilityPayloadDiagnosticContext,
  code: Extract<
    WorkerCapabilityPayloadAuthoringResult,
    { status: "failed" }
  >["code"],
  error?: unknown,
): WorkerCapabilityPayloadAuthoringResult {
  traceWorkerCapabilityPayloadFailed(diagnostic, code, error);
  return Object.freeze({ status: "failed" as const, code });
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function payloadAbort(reason: unknown): Error {
  const error =
    reason instanceof Error
      ? new Error(reason.message, { cause: reason })
      : new Error("Worker capability payload authoring aborted.");
  error.name = "AbortError";
  return error;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
