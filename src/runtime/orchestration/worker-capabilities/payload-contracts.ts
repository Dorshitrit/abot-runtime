import { MODEL_STEPS, type ModelStep } from "../../../shared/model-steps.js";
import type {
  RoleCallDependencyResult,
  RoleCallFrame,
} from "../role-calls/index.js";
import type {
  WorkerCapabilityControls,
  WorkerCapabilityDescriptor,
  WorkerCapabilityExecutionFreshness,
  WorkerSettledCapabilityResult,
} from "./contracts.js";

export const WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP =
  MODEL_STEPS.TOOL_PAYLOAD_RAW;
export const CAPABILITY_CONTROLS_MODEL_STEP = MODEL_STEPS.CAPABILITY_CONTROLS;
export const WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS =
  Object.freeze([
    MODEL_STEPS.WORKER_DECISION,
    CAPABILITY_CONTROLS_MODEL_STEP,
    MODEL_STEPS.WORKER_RESULT,
    MODEL_STEPS.REVIEWER_DECISION,
    WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP,
  ]) satisfies readonly ModelStep[];
export const WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_COUNT = 8;
export const WORKER_CAPABILITY_RELATED_ARTIFACT_CONTEXT_MAX_CHARS = 32_768;

export function workerCapabilityContextCompactionScopeId(
  callId: string,
): string {
  return `worker:${callId}:request-tool-results`;
}

export type WorkerCapabilityPayloadResponseFormat =
  | "json"
  | Readonly<Record<string, unknown>>;

export type WorkerCapabilityPayloadContextScope =
  | "standard"
  | "target_only"
  | "target_with_artifacts";

export type WorkerCapabilityPayloadContract = Readonly<{
  instructions: string;
  minBytes: number;
  maxBytes: number;
  responseFormat?: WorkerCapabilityPayloadResponseFormat;
}>;

export type WorkerCapabilityPayloadStageContext = Readonly<{
  index: number;
  count: number;
  outputParam: string;
  contextScope?: WorkerCapabilityPayloadContextScope;
}>;

export type WorkerCapabilityPayloadTargetContext = Readonly<{
  targetParam: string;
  targetPath: string;
  presentation: "bounded" | "full" | "full_numbered";
  content: string;
  sourceRange?: Readonly<{
    contextStartLine: number;
    contextEndLine: number;
    writableStartLine: number;
    writableEndLine: number;
    totalLines: number;
  }>;
}>;

export type WorkerCapabilityPayloadRelatedArtifactContext = Readonly<{
  sourceExecutionId: string;
  targetPath: string;
  presentation: "full";
  content: string;
}>;

type WorkerCapabilityPayloadSharedContext = Readonly<{
  contextScope: WorkerCapabilityPayloadContextScope;
  dependencyResults?: readonly RoleCallDependencyResult[];
  settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
  payloadContract: WorkerCapabilityPayloadContract;
  payloadStage?: WorkerCapabilityPayloadStageContext;
  materializedParams?: Readonly<Record<string, string>>;
  targetContext?: WorkerCapabilityPayloadTargetContext;
  relatedArtifactContexts?: readonly WorkerCapabilityPayloadRelatedArtifactContext[];
}>;

export type WorkerCapabilityPayloadContext =
  | Readonly<
      {
        worker: Readonly<{
          callId: string;
          parentCallId: string;
          invocationAttempt: number;
          objective: string;
        }>;
        acceptedCapability: Readonly<{
          capabilityId: string;
          summary: string;
          authoringObjective: string;
          controls: WorkerCapabilityControls;
        }>;
      } & WorkerCapabilityPayloadSharedContext
    >
  | Readonly<
      {
        root: Readonly<{
          callId: string;
          invocationAttempt: number;
          objectiveSource: "runtime_request_source_plus_steering_v1";
          steeringVersion: number;
          updates: WorkerCapabilityExecutionFreshness["token"]["updates"];
        }>;
        acceptedCapability: Readonly<{
          capabilityId: string;
          summary: string;
          controls: WorkerCapabilityControls;
        }>;
      } & WorkerCapabilityPayloadSharedContext
    >;

export type WorkerCapabilityPayloadModelRequest = Readonly<{
  /** Runtime-only binding; it is not projected into the model payload. */
  executionId: string;
  modelStep: typeof WORKER_CAPABILITY_RAW_PAYLOAD_MODEL_STEP;
  instructions: string;
  context: WorkerCapabilityPayloadContext;
  responseFormat?: WorkerCapabilityPayloadResponseFormat;
}>;

export type WorkerCapabilityPayloadModelPort = Readonly<{
  invoke(request: WorkerCapabilityPayloadModelRequest): Promise<unknown>;
}>;

export type WorkerCapabilityPayloadAuthoringResult =
  | Readonly<{ status: "authored"; body: string }>
  | Readonly<{
      status: "failed";
      code:
        | "payload_context_invalid"
        | "payload_context_budget_exceeded"
        | "payload_model_unavailable"
        | "payload_model_invocation_failed"
        | "payload_model_output_invalid"
        | "payload_body_too_small"
        | "payload_body_too_large";
    }>;

export type WorkerCapabilityPayloadValidationCode =
  | "payload_model_output_invalid"
  | "payload_body_too_small"
  | "payload_body_too_large";

export type WorkerCapabilityPayloadAuthor = Readonly<{
  author(
    input: Readonly<{
      call: RoleCallFrame;
      executionId: string;
      descriptor: WorkerCapabilityDescriptor;
      /** Required for Worker payloads and forbidden for direct-root payloads. */
      authoringObjective?: string;
      controls: WorkerCapabilityControls;
      contextScope?: WorkerCapabilityPayloadContextScope;
      dependencyResults?: readonly RoleCallDependencyResult[];
      settledCapabilityResults: readonly WorkerSettledCapabilityResult[];
      contract: WorkerCapabilityPayloadContract;
      stage?: WorkerCapabilityPayloadStageContext;
      materializedParams?: Readonly<Record<string, string>>;
      targetContext?: WorkerCapabilityPayloadTargetContext;
      relatedArtifactContexts?: readonly WorkerCapabilityPayloadRelatedArtifactContext[];
      /** Required for a direct-root payload and forbidden for a Worker payload. */
      requestSteering?: WorkerCapabilityExecutionFreshness["token"];
    }>,
  ): Promise<WorkerCapabilityPayloadAuthoringResult>;
}>;

export class WorkerCapabilityPayloadBudgetExceededError extends Error {
  constructor() {
    super("Worker capability payload context exceeds the model input budget.");
    this.name = "WorkerCapabilityPayloadBudgetExceededError";
  }
}

export class WorkerCapabilityPayloadValidationError extends Error {
  readonly code: WorkerCapabilityPayloadValidationCode;

  constructor(code: WorkerCapabilityPayloadValidationCode) {
    super(code);
    this.name = "WorkerCapabilityPayloadValidationError";
    this.code = code;
  }
}
