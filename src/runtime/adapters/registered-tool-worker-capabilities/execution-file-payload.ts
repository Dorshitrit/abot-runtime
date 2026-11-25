import { normalizePayloadAuthoringResult } from "./payload-authoring-result.js";
import { payloadAuthoringFailureMessage } from "./payload-authoring-failure.js";
import { prepareOperationPayload } from "./payload-lifecycle.js";
import { RUNTIME_ROOT_ROLE_ID } from "../../orchestration/roles.js";
import { FilePayloadToolHandoff } from "../../capabilities/file-payload-tool-handoff.js";
import { bindFilePayloadToolHandoff } from "./file-payload-tool-handoff.js";
import {
  executionFreshnessRejection, payloadRejection, rejectPayloadLifecycle,
} from "./payload-rejection.js";

type Preparation = Parameters<typeof prepareOperationPayload>[0];
type PreparationResult = Awaited<ReturnType<typeof prepareOperationPayload>>;

/** The legacy lifecycle remains intact for every operation without an EA source. */
export function prepareDeclaredOperationPayload(params: Preparation): Promise<PreparationResult> {
  if (!params.projection.preparePayload) return prepareOperationPayload(params);
  return prepareExecutionFilePayload(params);
}

async function prepareExecutionFilePayload(params: Preparation): Promise<PreparationResult> {
  if (!ownsPreparedFileSource(params)) {
    return payloadRejection("payload_source_authority_invalid", "File content requires its active EA assignment.");
  }
  const contract = params.projection.operation.payload;
  if (!contract || params.projection.stagedPayloadPlan) {
    return payloadRejection("payload_source_requires_single_payload", "The file operation requires one content payload.");
  }
  if (!params.payloadAuthor) {
    return payloadRejection("operation_payload_author_unavailable", "The capability payload author is unavailable.");
  }
  const lifecycle = { handle: params.projection.handle, controls: params.controls,
    ...(params.intent !== undefined ? { intent: params.intent } : {}) };
  const started = params.executor.emitPayloadLifecycle({ ...lifecycle, phase: "started" });
  if (started.status === "rejected") return payloadRejection(started.code, started.message);
  const reject = (code: string, message: string) => rejectPayloadLifecycle({
    executor: params.executor, lifecycle, code, message,
  });

  try {
    const source = await params.projection.preparePayload!(params.controls);
    const staleBeforeAuthoring = executionFreshnessRejection(params.executionFreshness);
    if (staleBeforeAuthoring) return reject(staleBeforeAuthoring.sourceIssueCode, staleBeforeAuthoring.result.summary);
    const authored = normalizePayloadAuthoringResult(await params.payloadAuthor.author({
      call: params.call, executionId: params.executionId, descriptor: params.descriptor,
      authoringObjective: params.authoringObjective, controls: params.controls,
      contextScope: "standard", settledCapabilityResults: params.settledCapabilityResults,
      ...(params.executionFreshness?.token.kind === "request_steering_v1"
        ? { requestSteering: params.executionFreshness.token } : {}),
      preparedPayload: { authoringContract: source.authoringContract, context: source.context,
        ...(source.responseFormat ? { responseFormat: source.responseFormat } : {}) },
      contract: { instructions: contract.instructions,
        minBytes: contract.minBytes ?? 0, maxBytes: contract.maxBytes },
    }), contract.minBytes ?? 0, contract.maxBytes);
    const superseded = executionFreshnessRejection(params.executionFreshness);
    if (superseded) return reject(superseded.sourceIssueCode, superseded.result.summary);
    if (authored.status === "failed") return reject(authored.code, payloadAuthoringFailureMessage(authored, "The file content could not be prepared."));
    const body = source.bind(authored.body);
    const completed = params.executor.emitPayloadLifecycle({ ...lifecycle, phase: "completed" });
    if (completed.status === "rejected") return payloadRejection(completed.code, completed.message);
    return Object.freeze({ status: "ready", body });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const superseded = executionFreshnessRejection(params.executionFreshness);
    if (superseded) return reject(superseded.sourceIssueCode, superseded.result.summary);
    if (error instanceof FilePayloadToolHandoff) {
      return bindFilePayloadToolHandoff(params, error, reject(error.code, error.message));
    }
    const code = filePreparationFailureCode(error);
    return reject(code, error instanceof Error ? error.message : "The file content could not be prepared.");
  }
}

function ownsPreparedFileSource(params: Preparation): boolean {
  if (params.call.parentCallId !== null || params.call.roleId !== RUNTIME_ROOT_ROLE_ID) return false;
  return params.executionFreshness?.token.kind === "request_steering_v1";
}

function filePreparationFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "payload_author_failed";
  if (!("code" in error) || typeof error.code !== "string") return "payload_author_failed";
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(error.code)) return "payload_author_failed";
  return error.code;
}
