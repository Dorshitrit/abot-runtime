import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import { projectRequestContext } from "../context/request-context.js";
import { createModelStepCompactionController } from "../context/model-step-compaction.js";
import { projectCurrentRequestToolResults } from "../context/request-tool-results.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "../context/semantic-compaction/index.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../context/request-source.js";
import { resolveModelContextBudget } from "../model/model-context-budget.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import {
  invokeRepairableRawModelStep,
  RawModelValidationError,
  type RawModelValidationResult,
} from "../model/invoke-raw-step.js";
import { traceDebug } from "../observability/debug-logger.js";
import {
  createWorkerCapabilityPayloadAuthor,
  workerCapabilityContextCompactionScopeId,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
  WorkerCapabilityPayloadBudgetExceededError,
  WorkerCapabilityPayloadValidationError,
  type WorkerCapabilityPayloadAuthor,
  type WorkerCapabilityPayloadModelRequest,
  type WorkerCapabilityPayloadResponseFormat,
  type WorkerCapabilityPayloadValidationCode,
} from "../orchestration/worker-capabilities/index.js";
import type { ExecutionPolicyCapabilityAuthority } from "../orchestration/role-calls/index.js";
import type {
  BoundRequestModelInvocationContext,
  RequestExecutionSeed,
} from "./contracts.js";
import { buildWorkerCapabilityPayloadRepairHint } from "./worker-capability-payload-prompts.js";

type RequestWorkerCapabilityPayloadContext =
  BoundRequestModelInvocationContext &
    Pick<
      RequestExecutionSeed,
      "prompt" | "historyMessages" | "onEvent" | "contextCompactionStore"
    >;

const PAYLOAD_TARGET_CONTENT_MESSAGE_KIND =
  "runtime_payload_target_content_v1" as const;
const PAYLOAD_RELATED_ARTIFACT_CONTENT_MESSAGE_KIND =
  "runtime_payload_related_artifact_content_v1" as const;
const WORKER_CAPABILITY_PAYLOAD_MAX_REPAIR_ATTEMPTS = 2;

type PayloadContext = WorkerCapabilityPayloadModelRequest["context"];
type PayloadSettledResult = PayloadContext["settledCapabilityResults"][number];
type ProjectedPayloadSettledResult = Readonly<
  Omit<PayloadSettledResult, "referenceData"> & {
    referenceData?: string;
    referenceDataRef?: string;
  }
>;

type SettledResultProjectionDiagnostics = Readonly<{
  sourceResultCount: number;
  includedResultCount: number;
  omittedResultCount: number;
  sourceSummaryCount: number;
  includedSummaryCount: number;
  omittedSummaryCount: number;
  sourceSummaryChars: number;
  includedSummaryChars: number;
  omittedSummaryChars: number;
  sourceReferenceDataCount: number;
  includedReferenceDataCount: number;
  omittedReferenceDataCount: number;
  sourceReferenceDataChars: number;
  includedReferenceDataChars: number;
  omittedReferenceDataChars: number;
  deduplicatedReferenceDataCount: number;
  deduplicatedReferenceDataChars: number;
}>;

/** Binds the neutral payload-author port to one request's model boundary. */
export function createRequestWorkerCapabilityPayloadAuthor(
  request: RequestWorkerCapabilityPayloadContext,
  capabilityAuthorities?: readonly ExecutionPolicyCapabilityAuthority[],
): WorkerCapabilityPayloadAuthor {
  return createWorkerCapabilityPayloadAuthor({
    requestId: request.requestId,
    abortSignal: request.abortSignal,
    ...(capabilityAuthorities ? { capabilityAuthorities } : {}),
    model: Object.freeze({
      invoke: (input: WorkerCapabilityPayloadModelRequest) =>
        invokePayloadModel(request, input),
    }),
  });
}

async function invokePayloadModel(
  request: RequestWorkerCapabilityPayloadContext,
  input: WorkerCapabilityPayloadModelRequest,
): Promise<string> {
  const compactionOptions = payloadCompactionOptions(input);
  try {
    return await invokeRepairableRawModelStep({
      request,
      modelStep: input.modelStep,
      messages: payloadMessages(request, input),
      contextCompaction: createModelStepCompactionController(request, {
        call: payloadCompactionCall(request.prompt, input.context),
        sourceRevision: payloadCompactionSourceRevision(input.context),
        allowedConsumers: compactionOptions.allowedConsumers,
        scopeId: compactionOptions.scopeId,
        ...(compactionOptions.resultSourceOverrides
          ? {
              resultSourceOverrides: compactionOptions.resultSourceOverrides,
            }
          : {}),
      }),
      timeoutReason: "worker_capability_payload_timeout",
      ...(input.responseFormat ? { format: input.responseFormat } : {}),
      maxRepairAttempts: WORKER_CAPABILITY_PAYLOAD_MAX_REPAIR_ATTEMPTS,
      validate: (text) =>
        validatePayloadModelOutput(
          text,
          input.context.payloadContract.minBytes,
          input.context.payloadContract.maxBytes,
          input.responseFormat,
        ),
      buildRepairHint: buildWorkerCapabilityPayloadRepairHint,
    });
  } catch (error: unknown) {
    const code = payloadValidationCode(error);
    if (code) {
      throw new WorkerCapabilityPayloadValidationError(code);
    }
    if (
      error instanceof Error &&
      (error.message.startsWith("context_compaction_") ||
        error.message.startsWith("request_context_"))
    ) {
      throw new WorkerCapabilityPayloadBudgetExceededError();
    }
    throw error;
  }
}

function validatePayloadModelOutput(
  text: string,
  minBytes: number,
  maxBytes: number,
  responseFormat: WorkerCapabilityPayloadResponseFormat | undefined,
): RawModelValidationResult {
  let normalized = text;
  if (responseFormat) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return invalidStructuredPayload(
        "output",
        "Return one valid JSON value matching the frozen response format.",
      );
    }
    if (responseFormat !== "json") {
      const schemaIssue = validateJsonSchemaValue(responseFormat, parsed);
      if (schemaIssue) {
        return invalidStructuredPayload(schemaIssue.path, schemaIssue.message);
      }
    }
    normalized = JSON.stringify(parsed);
  }
  const payloadBytes = Buffer.byteLength(normalized, "utf8");
  if (payloadBytes >= minBytes && payloadBytes <= maxBytes) {
    return Object.freeze({ ok: true as const, value: text });
  }
  const tooSmall = payloadBytes < minBytes;
  return Object.freeze({
    ok: false as const,
    stage: "payload_contract",
    issues: Object.freeze([
      Object.freeze({
        code: tooSmall ? "payload_body_too_small" : "payload_body_too_large",
        path: "output",
        message: tooSmall
          ? `Return the complete payload with at least ${minBytes} UTF-8 bytes; an empty response cannot satisfy this assignment.`
          : `Return the complete payload within ${maxBytes} UTF-8 bytes.`,
      }),
    ]),
    reason: tooSmall
      ? "worker_capability_payload_too_small"
      : "worker_capability_payload_too_large",
  });
}

function invalidStructuredPayload(
  path: string,
  message: string,
): Exclude<RawModelValidationResult, { ok: true }> {
  return Object.freeze({
    ok: false as const,
    stage: "payload_contract",
    issues: Object.freeze([
      Object.freeze({
        code: "payload_model_output_invalid",
        path,
        message,
      }),
    ]),
    reason: "worker_capability_payload_model_output_invalid",
  });
}

function payloadValidationCode(
  error: unknown,
): WorkerCapabilityPayloadValidationCode | undefined {
  if (
    !(error instanceof RawModelValidationError) ||
    error.stage !== "payload_contract"
  ) {
    return undefined;
  }
  const code = error.issues[0]?.code;
  return code === "payload_model_output_invalid" ||
    code === "payload_body_too_small" ||
    code === "payload_body_too_large"
    ? code
    : undefined;
}

function payloadMessages(
  request: RequestWorkerCapabilityPayloadContext,
  input: WorkerCapabilityPayloadModelRequest,
): ChatMessage[] {
  const callId = payloadContextCallId(input.context);
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: input.modelStep,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const requestSource =
    input.requestSourceProjection === "full_request"
      ? projectRequestSource({
          requestId: request.requestId,
          prompt: request.prompt,
          modelStep: input.modelStep,
          callId,
          historyMessages: request.historyMessages,
        })
      : undefined;
  const projectedContext = projectPayloadContext(input.context);
  traceDebug("runtime.worker_capability_payload_context", "projected", {
    requestId: request.requestId,
    modelStep: input.modelStep,
    callId,
    contextScope: projectedContext.contextScope,
    settledCapabilityResultCount: input.context.settledCapabilityResults.length,
    ...projectedContext.settledResultDiagnostics,
    relatedArtifactContextCount:
      projectedContext.relatedArtifactMessages.length,
    sourceRelatedArtifactContextCount:
      input.context.relatedArtifactContexts?.length ?? 0,
    hasTargetContext: input.context.targetContext !== undefined,
    requestSourceProjection: input.requestSourceProjection,
  });
  try {
    return projectRequestContext({
      instructions: input.instructions,
      historyMessages: [],
      prompt: `Canonical runtime context:\n${JSON.stringify(projectedContext.metadata)}`,
      referenceMessages: [
        ...(requestSource ? [buildRequestSourceMessage(requestSource)] : []),
        ...projectedContext.relatedArtifactMessages,
      ],
      ...(projectedContext.targetContentMessage
        ? { continuationMessages: [projectedContext.targetContentMessage] }
        : {}),
      budget,
      diagnostic: {
        requestId: request.requestId,
        modelStep: input.modelStep,
        callId,
      },
      onEvent: request.onEvent,
      deferCompactionFailure: true,
    }).messages;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message === "request_context_pinned_content_exceeds_budget" ||
        error.message === "request_context_required_content_exceeds_budget")
    ) {
      throw new WorkerCapabilityPayloadBudgetExceededError();
    }
    throw error;
  }
}

function payloadContextCallId(context: PayloadContext): string {
  return "worker" in context ? context.worker.callId : context.root.callId;
}

function payloadCompactionCall(requestPrompt: string, context: PayloadContext) {
  return Object.freeze(
    "worker" in context
      ? {
          roleId: "worker",
          callId: context.worker.callId,
          objective: context.worker.objective,
        }
      : {
          roleId: "root",
          callId: context.root.callId,
          objective: [
            requestPrompt,
            ...context.root.updates.map(({ text }) => text),
          ].join("\n"),
        },
  );
}

function payloadCompactionSourceRevision(context: PayloadContext): number {
  const invocationAttempt =
    "worker" in context
      ? context.worker.invocationAttempt
      : context.root.invocationAttempt;
  return Math.max(
    invocationAttempt,
    context.payloadStage?.index ?? 0,
    context.settledCapabilityResults.length,
  );
}

function payloadCompactionOptions(
  input: WorkerCapabilityPayloadModelRequest,
): Readonly<{
  allowedConsumers: readonly ModelStep[];
  scopeId: string;
  resultSourceOverrides?: readonly SemanticCompactionSource[];
}> {
  if ("worker" in input.context) {
    return Object.freeze({
      allowedConsumers: WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
      scopeId: workerCapabilityContextCompactionScopeId(
        input.context.worker.callId,
      ),
      resultSourceOverrides: createWorkerPayloadResultSources(input.context),
    });
  }
  return Object.freeze({
    allowedConsumers: Object.freeze([input.modelStep]),
    scopeId: [
      "payload",
      payloadContextCallId(input.context),
      input.executionId,
      input.context.payloadStage?.index ?? 0,
    ].join(":"),
  });
}

function createWorkerPayloadResultSources(
  context: PayloadContext,
): readonly SemanticCompactionSource[] {
  return Object.freeze(
    projectCurrentRequestToolResults(context.settledCapabilityResults).map(
      (result) => {
        const content = JSON.stringify(result);
        return Object.freeze({
          sourceRef: result.executionId,
          sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
          content,
        });
      },
    ),
  );
}

function projectPayloadContext(context: PayloadContext): Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  relatedArtifactMessages: readonly ChatMessage[];
  targetContentMessage?: ChatMessage;
  contextScope: PayloadContext["contextScope"];
  settledResultDiagnostics: SettledResultProjectionDiagnostics;
}> {
  const contextScope = context.contextScope;
  const targetProjection = context.targetContext
    ? projectTargetContext(context.targetContext)
    : undefined;
  const relatedArtifactProjections =
    contextScope === "target_only"
      ? []
      : (context.relatedArtifactContexts ?? []).map((artifact, index) =>
          projectRelatedArtifactContext(artifact, index),
        );
  const settledResultProjection = projectSettledResultsForPayload(
    context,
    contextScope,
  );
  const baseMetadata: Record<string, unknown> = { ...context };
  delete baseMetadata.targetContext;
  delete baseMetadata.relatedArtifactContexts;
  return Object.freeze({
    metadata: Object.freeze({
      ...baseMetadata,
      settledCapabilityResults: settledResultProjection.results,
      ...(targetProjection ? { targetContext: targetProjection.metadata } : {}),
      ...(relatedArtifactProjections.length > 0
        ? {
            relatedArtifactContexts: Object.freeze(
              relatedArtifactProjections.map(({ metadata }) => metadata),
            ),
          }
        : {}),
    }),
    relatedArtifactMessages: Object.freeze(
      relatedArtifactProjections.map(({ message }) => message),
    ),
    ...(targetProjection
      ? { targetContentMessage: targetProjection.message }
      : {}),
    contextScope,
    settledResultDiagnostics: settledResultProjection.diagnostics,
  });
}

/**
 * Applies only manifest-owned payload context scope at the request/model
 * boundary. Canonical settled results remain untouched upstream. A represented
 * body replaces inline reference data only when both its provenance and exact
 * string identity are mechanically established.
 */
function projectSettledResultsForPayload(
  context: PayloadContext,
  contextScope: PayloadContext["contextScope"],
): Readonly<{
  results: readonly ProjectedPayloadSettledResult[];
  diagnostics: SettledResultProjectionDiagnostics;
}> {
  const sourceResults = context.settledCapabilityResults;
  let deduplicatedReferenceDataCount = 0;
  let deduplicatedReferenceDataChars = 0;
  const results: readonly ProjectedPayloadSettledResult[] =
    contextScope === "target_only"
      ? Object.freeze([])
      : contextScope === "standard"
        ? sourceResults
        : Object.freeze(
            sourceResults.map((result) => {
              const referenceDataRef = exactRepresentedReferenceDataRef(
                context,
                result,
              );
              if (!referenceDataRef || !result.referenceData) return result;
              const { referenceData, ...receipt } = result;
              deduplicatedReferenceDataCount += 1;
              deduplicatedReferenceDataChars += referenceData.length;
              return Object.freeze({ ...receipt, referenceDataRef });
            }),
          );
  const diagnostics = projectSettledResultDiagnostics({
    sourceResults,
    includedResults: results,
    deduplicatedReferenceDataCount,
    deduplicatedReferenceDataChars,
  });
  return Object.freeze({
    results,
    diagnostics,
  });
}

function exactRepresentedReferenceDataRef(
  context: PayloadContext,
  result: PayloadSettledResult,
): string | undefined {
  const referenceData = result.referenceData;
  if (!referenceData || !result.references) return undefined;

  const target = context.targetContext;
  if (
    target &&
    referenceData === target.content &&
    result.references.some(({ target: referenceTarget }) =>
      sameTargetReference(referenceTarget, target.targetPath),
    )
  ) {
    return PAYLOAD_TARGET_CONTENT_MESSAGE_KIND;
  }

  for (const [index, artifact] of (
    context.relatedArtifactContexts ?? []
  ).entries()) {
    if (
      artifact.sourceExecutionId === result.executionId &&
      referenceData === artifact.content &&
      result.references.some(({ target: referenceTarget }) =>
        sameTargetReference(referenceTarget, artifact.targetPath),
      )
    ) {
      return `${PAYLOAD_RELATED_ARTIFACT_CONTENT_MESSAGE_KIND}:${index + 1}`;
    }
  }
  return undefined;
}

function sameTargetReference(left: string, right: string): boolean {
  return left === right;
}

function projectSettledResultDiagnostics(
  params: Readonly<{
    sourceResults: readonly PayloadSettledResult[];
    includedResults: readonly ProjectedPayloadSettledResult[];
    deduplicatedReferenceDataCount: number;
    deduplicatedReferenceDataChars: number;
  }>,
): SettledResultProjectionDiagnostics {
  const sourceSummaryChars = sumSummaryChars(params.sourceResults);
  const includedSummaryChars = sumSummaryChars(params.includedResults);
  const sourceReferenceDataCount = countReferenceData(params.sourceResults);
  const includedReferenceDataCount = countReferenceData(params.includedResults);
  const sourceReferenceDataChars = sumReferenceDataChars(params.sourceResults);
  const includedReferenceDataChars = sumReferenceDataChars(
    params.includedResults,
  );
  return Object.freeze({
    sourceResultCount: params.sourceResults.length,
    includedResultCount: params.includedResults.length,
    omittedResultCount:
      params.sourceResults.length - params.includedResults.length,
    sourceSummaryCount: params.sourceResults.length,
    includedSummaryCount: params.includedResults.length,
    omittedSummaryCount:
      params.sourceResults.length - params.includedResults.length,
    sourceSummaryChars,
    includedSummaryChars,
    omittedSummaryChars: sourceSummaryChars - includedSummaryChars,
    sourceReferenceDataCount,
    includedReferenceDataCount,
    omittedReferenceDataCount:
      sourceReferenceDataCount - includedReferenceDataCount,
    sourceReferenceDataChars,
    includedReferenceDataChars,
    omittedReferenceDataChars:
      sourceReferenceDataChars - includedReferenceDataChars,
    deduplicatedReferenceDataCount: params.deduplicatedReferenceDataCount,
    deduplicatedReferenceDataChars: params.deduplicatedReferenceDataChars,
  });
}

function sumSummaryChars(
  results: readonly Readonly<{ summary: string }>[],
): number {
  return results.reduce((total, { summary }) => total + summary.length, 0);
}

function countReferenceData(
  results: readonly Readonly<{ referenceData?: string }>[],
): number {
  return results.reduce(
    (total, { referenceData }) => total + (referenceData ? 1 : 0),
    0,
  );
}

function sumReferenceDataChars(
  results: readonly Readonly<{ referenceData?: string }>[],
): number {
  return results.reduce(
    (total, { referenceData }) => total + (referenceData?.length ?? 0),
    0,
  );
}

function projectTargetContext(
  targetContext: NonNullable<
    WorkerCapabilityPayloadModelRequest["context"]["targetContext"]
  >,
) {
  const { content, ...targetMetadata } = targetContext;
  return Object.freeze({
    metadata: Object.freeze({
      ...targetMetadata,
      contentRef: PAYLOAD_TARGET_CONTENT_MESSAGE_KIND,
    }),
    message: Object.freeze({
      role: "user" as const,
      content: [
        JSON.stringify({
          kind: PAYLOAD_TARGET_CONTENT_MESSAGE_KIND,
          authority: "reference_data",
          targetParam: targetContext.targetParam,
          targetPath: targetContext.targetPath,
          presentation: targetContext.presentation,
          contentEncoding: "verbatim_utf8",
          contentStartsNextLine: true,
          ...(targetContext.sourceRange
            ? { sourceRange: targetContext.sourceRange }
            : {}),
        }),
        content,
      ].join("\n"),
    }),
  });
}

function projectRelatedArtifactContext(
  artifact: NonNullable<
    WorkerCapabilityPayloadModelRequest["context"]["relatedArtifactContexts"]
  >[number],
  index: number,
) {
  const contentRef = `${PAYLOAD_RELATED_ARTIFACT_CONTENT_MESSAGE_KIND}:${index + 1}`;
  return Object.freeze({
    metadata: Object.freeze({
      sourceExecutionId: artifact.sourceExecutionId,
      targetPath: artifact.targetPath,
      presentation: artifact.presentation,
      contentRef,
    }),
    message: Object.freeze({
      role: "user" as const,
      content: [
        JSON.stringify({
          kind: PAYLOAD_RELATED_ARTIFACT_CONTENT_MESSAGE_KIND,
          authority: "reference_data",
          contentRef,
          sourceExecutionId: artifact.sourceExecutionId,
          targetPath: artifact.targetPath,
          presentation: artifact.presentation,
          contentEncoding: "verbatim_utf8",
          contentStartsNextLine: true,
        }),
        artifact.content,
      ].join("\n"),
    }),
  });
}
