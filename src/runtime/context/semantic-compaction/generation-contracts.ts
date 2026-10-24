import type { ModelStep } from "../../../shared/model-steps.js";
import type {
  SemanticCompactionCheckpoint,
  SemanticCompactionCheckpointBinding,
  SemanticCompactionDigest,
  SemanticCompactionSource,
} from "./contracts.js";
import type {
  BoundRequestModelInvocationContext,
  RequestExecutionSeed,
} from "../../request/contracts.js";
import type { SuperCompactionFailureOwner } from "../super-compaction-failure-owner.js";

export type SemanticCompactionGenerationParams = Readonly<{
  request: SemanticCompactionRequest;
  scopeId: string;
  binding: SemanticCompactionCheckpointBinding;
  sourceRevision: number;
  preservationObjective: string;
  /** Invocation-local freshness binding; never part of a saved checkpoint. */
  boundSteeringVersion?: number;
  previous?: SemanticCompactionCheckpoint;
  /** Verified EA predecessor evidence only; exclusive with previous and never persisted. */
  inheritedSourceDigests?: readonly SemanticCompactionDigest[];
  /** Model step that will consume the checkpoint. */
  consumer?: ModelStep;
  sources: readonly SemanticCompactionSource[];
  registrationMode?: "atomic";
  failureOwner?: SuperCompactionFailureOwner;
}>;

export type SemanticCompactionRequest = BoundRequestModelInvocationContext &
  Pick<RequestExecutionSeed, "prompt" | "contextCompactionStore">;
