import type { ModelStep } from "../../../shared/model-steps.js";
import type {
  SemanticCompactionCheckpoint,
  SemanticCompactionCheckpointBinding,
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
  previous?: SemanticCompactionCheckpoint;
  /** Model step that will consume the checkpoint. */
  consumer?: ModelStep;
  sources: readonly SemanticCompactionSource[];
  registrationMode?: "atomic";
  failureOwner?: SuperCompactionFailureOwner;
}>;

export type SemanticCompactionRequest = BoundRequestModelInvocationContext &
  Pick<RequestExecutionSeed, "prompt" | "contextCompactionStore">;
