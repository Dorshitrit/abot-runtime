import type { ToolExecutionSharedState } from "../../../capabilities/tool-types.js";
import type { CapabilityAdapterResult } from "../../orchestration/capability-adapters/index.js";
import type {
  WorkerCapabilityAdapterResult,
  WorkerCapabilityExecutionFreshness,
  WorkerCapabilityPayloadAuthor,
} from "../../orchestration/worker-capabilities/index.js";
import type { RegisteredToolNormalInvocationProjection } from "../registered-tool-normal-invocations.js";
import {
  materializeRegisteredToolPayloadStageResponseFormat,
  resolveRegisteredToolPayloadRelatedArtifactContexts,
  resolveRegisteredToolPayloadStageLiteralOutput,
  resolveRegisteredToolPayloadStageMinBytes,
  resolveRegisteredToolPayloadTargetContext,
  validateRegisteredToolPayloadStageTargetLineBounds,
  type RegisteredToolPayloadStage,
  type RegisteredToolStagedPayloadPlan,
} from "../registered-tool-payload-plan.js";
import { normalizePayloadAuthoringResult } from "./payload-authoring-result.js";
import {
  executionFreshnessRejection,
  payloadRejection,
  rejectPayloadLifecycle,
  STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
  STEERING_SUPERSEDED_SUMMARY,
  type PayloadLifecycleContext,
} from "./payload-rejection.js";
import type {
  PayloadLifecycleEmitter,
  PayloadStageMaterializationDetails,
} from "./payload-observability.js";

export type StagedOperationPayloadParams = Readonly<{
  plan: RegisteredToolStagedPayloadPlan;
  handle: RegisteredToolNormalInvocationProjection["handle"];
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
}>;

export type StagedOperationPayloadResult =
  | Readonly<{
      status: "ready";
      materializedParams: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      status: "rejected";
      result: WorkerCapabilityAdapterResult;
      sourceIssueCode: string;
      exactResult: CapabilityAdapterResult;
    }>;

export async function prepareStagedOperationPayload(
  params: StagedOperationPayloadParams,
): Promise<StagedOperationPayloadResult> {
  return new PayloadStageRunner(params).run();
}

type PayloadStageRejection = Extract<
  StagedOperationPayloadResult,
  Readonly<{ status: "rejected" }>
>;

type PayloadStageStarted = Readonly<{
  status: "ready";
  stageIndex: number;
  stageCount: number;
  lifecycle: PayloadLifecycleContext;
}>;

type PayloadStageInputs = Readonly<{
  status: "ready";
  materializedParams: Readonly<Record<string, string>> | undefined;
  effectiveMinBytes: number;
  targetContext: Awaited<
    ReturnType<typeof resolveRegisteredToolPayloadTargetContext>
  >;
  responseFormat: ReturnType<
    typeof materializeRegisteredToolPayloadStageResponseFormat
  >;
  literalResolution: ReturnType<
    typeof resolveRegisteredToolPayloadStageLiteralOutput
  >;
}>;

type PayloadStageValidated = Readonly<{
  status: "ready";
  body: string;
}>;

type PayloadStageCompleted = Readonly<{ status: "completed" }>;

/** Owns the ordered payload-stage lifecycle for one capability execution. */
class PayloadStageRunner {
  constructor(private readonly params: StagedOperationPayloadParams) {}

  async run(): Promise<StagedOperationPayloadResult> {
    const payloadAuthor = this.params.payloadAuthor;
    if (!payloadAuthor) {
      return payloadRejection(
        "operation_payload_author_unavailable",
        "The capability payload author is unavailable.",
      );
    }

    const materialized: Record<string, string> = {};
    for (const [stageOffset, stage] of this.params.plan.stages.entries()) {
      const completed = await this.runStage({
        stage,
        stageOffset,
        materialized,
        payloadAuthor,
      });
      if (completed.status === "rejected") {
        return completed;
      }
    }

    return Object.freeze({
      status: "ready" as const,
      materializedParams: Object.freeze({ ...materialized }),
    });
  }

  private async runStage(
    input: Readonly<{
      stage: RegisteredToolPayloadStage;
      stageOffset: number;
      materialized: Record<string, string>;
      payloadAuthor: WorkerCapabilityPayloadAuthor;
    }>,
  ): Promise<PayloadStageCompleted | PayloadStageRejection> {
    const started = this.startStage(input.stage, input.stageOffset);
    if (started.status === "rejected") {
      return started;
    }
    const stageInputs = await this.resolveStageInputs(
      input.stage,
      input.materialized,
      started.lifecycle,
    );
    if (stageInputs.status === "rejected") {
      return stageInputs;
    }
    const validated = await this.authorStage(
      input.stage,
      started,
      stageInputs,
      input.payloadAuthor,
    );
    if (validated.status === "rejected") {
      return validated;
    }
    return this.completeStage({
      stage: input.stage,
      started,
      stageInputs,
      body: validated.body,
      materialized: input.materialized,
    });
  }

  private startStage(
    stage: RegisteredToolPayloadStage,
    stageOffset: number,
  ): PayloadStageStarted | PayloadStageRejection {
    const stageIndex = stageOffset + 1;
    const stageCount = this.params.plan.stages.length;
    const lifecycle: PayloadLifecycleContext = {
      handle: this.params.handle,
      controls: this.params.controls,
      intent: this.params.intent,
      payloadStage: stageIndex,
      payloadStageCount: stageCount,
      outputParam: stage.outputParam,
    };
    const started = this.params.executor.emitPayloadLifecycle({
      ...lifecycle,
      phase: "started",
    });
    return started.status === "rejected"
      ? payloadRejection(started.code, started.message)
      : Object.freeze({
          status: "ready" as const,
          stageIndex,
          stageCount,
          lifecycle,
        });
  }

  private async resolveStageInputs(
    stage: RegisteredToolPayloadStage,
    materialized: Readonly<Record<string, string>>,
    lifecycle: PayloadLifecycleContext,
  ): Promise<PayloadStageInputs | PayloadStageRejection> {
    const priorParams = selectMaterializedParams(stage, materialized);
    if (!priorParams.ok) {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: "payload_stage_dependency_unavailable",
        message: "A prior capability payload stage result is unavailable.",
      });
    }

    const effectiveMinBytes = resolveRegisteredToolPayloadStageMinBytes({
      stage,
      ...(priorParams.value ? { materializedParams: priorParams.value } : {}),
    });
    if (effectiveMinBytes === undefined) {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: "payload_stage_min_bytes_unavailable",
        message:
          "A prior capability payload stage result cannot resolve the payload byte minimum.",
      });
    }

    let targetContext;
    try {
      targetContext = await resolveRegisteredToolPayloadTargetContext({
        plan: this.params.plan,
        stage,
        controls: this.params.controls,
        sharedState: this.params.sharedState,
        ...(priorParams.value ? { materializedParams: priorParams.value } : {}),
      });
    } catch {
      targetContext = undefined;
    }
    if (stage.targetContext && !targetContext) {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: "payload_target_context_unavailable",
        message: "The capability payload target context is unavailable.",
      });
    }

    let responseFormat;
    try {
      responseFormat = materializeRegisteredToolPayloadStageResponseFormat({
        stage,
        ...(targetContext ? { targetContext } : {}),
      });
    } catch {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: "payload_stage_target_line_bound_unavailable",
        message: "The capability payload target line bound is unavailable.",
      });
    }

    const literalResolution = resolveRegisteredToolPayloadStageLiteralOutput({
      stage,
      ...(priorParams.value ? { materializedParams: priorParams.value } : {}),
    });
    if (literalResolution.status === "invalid_dependency") {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: "payload_stage_literal_dependency_invalid",
        message:
          "A prior capability payload stage result cannot resolve the declared literal output.",
      });
    }

    return Object.freeze({
      status: "ready" as const,
      materializedParams: priorParams.value,
      effectiveMinBytes,
      targetContext,
      responseFormat,
      literalResolution,
    });
  }

  private async authorStage(
    stage: RegisteredToolPayloadStage,
    started: PayloadStageStarted,
    stageInputs: PayloadStageInputs,
    payloadAuthor: WorkerCapabilityPayloadAuthor,
  ): Promise<PayloadStageValidated | PayloadStageRejection> {
    let rawAuthored: unknown;
    if (stageInputs.literalResolution.status === "matched") {
      rawAuthored = Object.freeze({
        status: "authored" as const,
        body: stageInputs.literalResolution.body,
      });
    } else {
      try {
        const contextScope = stage.contextScope ?? "standard";
        const relatedArtifactContexts =
          await resolveRegisteredToolPayloadRelatedArtifactContexts({
            contextScope,
            targetParam: this.params.plan.targetParam,
            controls: this.params.controls,
            sharedState: this.params.sharedState,
            settledCapabilityResults: this.params.settledCapabilityResults,
          });
        rawAuthored = await payloadAuthor.author({
          call: this.params.call,
          executionId: this.params.executionId,
          descriptor: this.params.descriptor,
          ...(this.params.authoringObjective
            ? { authoringObjective: this.params.authoringObjective }
            : {}),
          controls: this.params.controls,
          contextScope,
          ...(this.params.dependencyResults
            ? { dependencyResults: this.params.dependencyResults }
            : {}),
          settledCapabilityResults: this.params.settledCapabilityResults,
          ...(this.params.executionFreshness
            ? { requestSteering: this.params.executionFreshness.token }
            : {}),
          ...(relatedArtifactContexts.length > 0
            ? { relatedArtifactContexts }
            : {}),
          contract: {
            instructions: stage.instructions,
            minBytes: stageInputs.effectiveMinBytes,
            maxBytes: stage.maxBytes,
            ...(stageInputs.responseFormat
              ? { responseFormat: stageInputs.responseFormat }
              : {}),
          },
          stage: {
            index: started.stageIndex,
            count: started.stageCount,
            outputParam: stage.outputParam,
            ...(stage.contextScope ? { contextScope: stage.contextScope } : {}),
          },
          ...(stageInputs.materializedParams
            ? { materializedParams: stageInputs.materializedParams }
            : {}),
          ...(stageInputs.targetContext
            ? { targetContext: stageInputs.targetContext }
            : {}),
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          throw error;
        }
        return rejectPayloadLifecycle({
          executor: this.params.executor,
          lifecycle: started.lifecycle,
          code: "payload_author_failed",
          message: "The capability payload could not be prepared.",
        });
      }
    }
    return this.validateAuthoredStage(
      stage,
      stageInputs,
      rawAuthored,
      started.lifecycle,
    );
  }

  private validateAuthoredStage(
    stage: RegisteredToolPayloadStage,
    stageInputs: PayloadStageInputs,
    rawAuthored: unknown,
    lifecycle: PayloadLifecycleContext,
  ): PayloadStageValidated | PayloadStageRejection {
    const superseded = executionFreshnessRejection(
      this.params.executionFreshness,
    );
    if (superseded) {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: STEERING_SUPERSEDED_BEFORE_EXTERNAL_EXECUTION,
        message: STEERING_SUPERSEDED_SUMMARY,
        fallback: superseded,
      });
    }

    const authored = normalizePayloadAuthoringResult(
      rawAuthored,
      stageInputs.literalResolution.status === "matched"
        ? this.params.plan.payloadMinBytes
        : stageInputs.effectiveMinBytes,
      stage.maxBytes,
      stageInputs.responseFormat,
    );
    if (authored.status === "failed") {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: authored.code,
        message: "The capability payload could not be prepared.",
      });
    }

    if (
      !validateRegisteredToolPayloadStageTargetLineBounds({
        stage,
        ...(stageInputs.targetContext
          ? { targetContext: stageInputs.targetContext }
          : {}),
        body: authored.body,
      })
    ) {
      return rejectPayloadLifecycle({
        executor: this.params.executor,
        lifecycle,
        code: "payload_stage_target_line_bound_invalid",
        message:
          "The capability payload selected a line outside the current target.",
      });
    }
    return Object.freeze({ status: "ready" as const, body: authored.body });
  }

  private completeStage(
    input: Readonly<{
      stage: RegisteredToolPayloadStage;
      started: PayloadStageStarted;
      stageInputs: PayloadStageInputs;
      body: string;
      materialized: Record<string, string>;
    }>,
  ): PayloadStageCompleted | PayloadStageRejection {
    if (input.stageInputs.literalResolution.status === "matched") {
      this.params.deferPayloadStageMaterialized({
        payloadStage: input.started.stageIndex,
        payloadStageCount: input.started.stageCount,
        source: "manifest_literal",
        byteCount: Buffer.byteLength(input.body, "utf8"),
      });
    }
    input.materialized[input.stage.outputParam] = input.body;
    const completed = this.params.executor.emitPayloadLifecycle({
      ...input.started.lifecycle,
      phase: "completed",
    });
    return completed.status === "rejected"
      ? payloadRejection(completed.code, completed.message)
      : Object.freeze({ status: "completed" as const });
  }
}

function selectMaterializedParams(
  stage: RegisteredToolPayloadStage,
  materialized: Readonly<Record<string, string>>,
):
  | Readonly<{
      ok: true;
      value?: Readonly<Record<string, string>>;
    }>
  | Readonly<{ ok: false }> {
  if (stage.includeMaterializedParams.length === 0) {
    return Object.freeze({ ok: true as const });
  }
  const selected: Record<string, string> = {};
  for (const name of stage.includeMaterializedParams) {
    const value = materialized[name];
    if (typeof value !== "string") {
      return Object.freeze({ ok: false as const });
    }
    selected[name] = value;
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze(selected),
  });
}
