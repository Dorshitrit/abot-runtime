import type { ToolExecutionSharedState } from "../../../capabilities/tool-types.js";
import type { CapabilityAdapterResult } from "../../orchestration/capability-adapters/index.js";
import type {
  WorkerCapabilityAdapterResult,
  WorkerCapabilityExecutionFreshness,
  WorkerCapabilityPayloadAuthor,
} from "../../orchestration/worker-capabilities/index.js";
import type { RegisteredToolNormalInvocationProjection } from "../registered-tool-normal-invocations.js";
import { resolveRegisteredToolPayloadRelatedArtifactContexts } from "../registered-tool-payload-plan.js";
import { normalizePayloadAuthoringResult } from "./payload-authoring-result.js";
import {
  executionFreshnessRejection,
  payloadRejection,
  rejectPayloadLifecycle,
  STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
  STEERING_SUPERSEDED_SUMMARY,
} from "./payload-rejection.js";
import { prepareStagedOperationPayload } from "./payload-stages.js";
import type {
  PayloadLifecycleEmitter,
  PayloadStageMaterializationDetails,
} from "./payload-observability.js";

export async function prepareOperationPayload(
  params: Readonly<{
    projection: RegisteredToolNormalInvocationProjection;
    executor: PayloadLifecycleEmitter;
    sharedState: ToolExecutionSharedState;
    payloadAuthor?: WorkerCapabilityPayloadAuthor;
    call: Parameters<WorkerCapabilityPayloadAuthor["author"]>[0]["call"];
    executionId: string;
    descriptor: Parameters<
      WorkerCapabilityPayloadAuthor["author"]
    >[0]["descriptor"];
    intent: string;
    authoringObjective?: string;
    controls: Readonly<Record<string, unknown>>;
    dependencyResults?: Parameters<
      WorkerCapabilityPayloadAuthor["author"]
    >[0]["dependencyResults"];
    settledCapabilityResults: Parameters<
      WorkerCapabilityPayloadAuthor["author"]
    >[0]["settledCapabilityResults"];
    deferPayloadStageMaterialized(
      details: PayloadStageMaterializationDetails,
    ): void;
    executionFreshness?: WorkerCapabilityExecutionFreshness;
  }>,
): Promise<
  | Readonly<{
      status: "ready";
      body?: string;
      materializedParams?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      status: "rejected";
      result: WorkerCapabilityAdapterResult;
      sourceIssueCode: string;
      exactResult: CapabilityAdapterResult;
    }>
> {
  if (params.projection.stagedPayloadPlan) {
    return prepareStagedOperationPayload({
      plan: params.projection.stagedPayloadPlan,
      handle: params.projection.handle,
      executor: params.executor,
      sharedState: params.sharedState,
      ...(params.payloadAuthor ? { payloadAuthor: params.payloadAuthor } : {}),
      call: params.call,
      executionId: params.executionId,
      descriptor: params.descriptor,
      intent: params.intent,
      ...(params.authoringObjective
        ? { authoringObjective: params.authoringObjective }
        : {}),
      controls: params.controls,
      ...(params.dependencyResults
        ? { dependencyResults: params.dependencyResults }
        : {}),
      settledCapabilityResults: params.settledCapabilityResults,
      deferPayloadStageMaterialized: params.deferPayloadStageMaterialized,
      ...(params.executionFreshness
        ? { executionFreshness: params.executionFreshness }
        : {}),
    });
  }

  const contract = params.projection.operation.payload;
  if (!contract) {
    return Object.freeze({ status: "ready" as const });
  }
  if (!params.payloadAuthor) {
    return payloadRejection(
      "operation_payload_author_unavailable",
      "The capability payload author is unavailable.",
    );
  }

  const lifecycle = {
    handle: params.projection.handle,
    controls: params.controls,
    intent: params.intent,
  };
  const started = params.executor.emitPayloadLifecycle({
    ...lifecycle,
    phase: "started",
  });
  if (started.status === "rejected") {
    return payloadRejection(started.code, started.message);
  }

  let rawAuthored: unknown;
  try {
    const contextScope =
      params.projection.payloadContextPlan?.contextScope ?? "standard";
    const relatedArtifactContexts =
      await resolveRegisteredToolPayloadRelatedArtifactContexts({
        contextScope,
        targetParam: params.projection.payloadContextPlan?.targetParam,
        controls: params.controls,
        sharedState: params.sharedState,
        settledCapabilityResults: params.settledCapabilityResults,
      });
    rawAuthored = await params.payloadAuthor.author({
      call: params.call,
      executionId: params.executionId,
      descriptor: params.descriptor,
      ...(params.authoringObjective
        ? { authoringObjective: params.authoringObjective }
        : {}),
      controls: params.controls,
      contextScope,
      ...(params.dependencyResults
        ? { dependencyResults: params.dependencyResults }
        : {}),
      settledCapabilityResults: params.settledCapabilityResults,
      ...(params.executionFreshness
        ? { requestSteering: params.executionFreshness.token }
        : {}),
      ...(relatedArtifactContexts.length > 0
        ? { relatedArtifactContexts }
        : {}),
      contract: {
        instructions: contract.instructions,
        minBytes: contract.minBytes ?? 0,
        maxBytes: contract.maxBytes,
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    return rejectPayloadLifecycle({
      executor: params.executor,
      lifecycle,
      code: "payload_author_failed",
      message: "The capability payload could not be prepared.",
    });
  }
  const superseded = executionFreshnessRejection(params.executionFreshness);
  if (superseded) {
    return rejectPayloadLifecycle({
      executor: params.executor,
      lifecycle,
      code: STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
      message: STEERING_SUPERSEDED_SUMMARY,
      fallback: superseded,
    });
  }
  const authored = normalizePayloadAuthoringResult(
    rawAuthored,
    contract.minBytes ?? 0,
    contract.maxBytes,
  );
  if (authored.status === "failed") {
    return rejectPayloadLifecycle({
      executor: params.executor,
      lifecycle,
      code: authored.code,
      message: "The capability payload could not be prepared.",
    });
  }
  const completed = params.executor.emitPayloadLifecycle({
    ...lifecycle,
    phase: "completed",
  });
  if (completed.status === "rejected") {
    return payloadRejection(completed.code, completed.message);
  }
  return Object.freeze({ status: "ready" as const, body: authored.body });
}
export {
  executionFreshnessRejection,
  payloadRejection,
} from "./payload-rejection.js";
