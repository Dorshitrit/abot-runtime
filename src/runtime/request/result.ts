import type { SessionMessageObservationMeta } from "../../sessions/types.js";
import type { MemoryCandidate } from "../long-term-memory/contracts.js";
export type {
  RequestApprovalContinuation,
  RequestRunnerOutcome,
} from "./approval-continuation.js";

export type RequestObservation = {
  observationMeta?: SessionMessageObservationMeta;
  observationContent: string;
};

export type RequestOutputTextMode = "exact";
export type RequestCompletionDisposition = "responded" | "blocked";

export type RequestRunnerResult = {
  output: string;
  /** Explicit root blockage; omission preserves ordinary response semantics. */
  disposition?: RequestCompletionDisposition;
  /** Omission preserves the legacy normalized finalization contract. */
  outputTextMode?: RequestOutputTextMode;
  finalObservation?: RequestObservation;
  memoryCandidates?: readonly MemoryCandidate[];
};

export type RequestRoleExecutionHandoff = Readonly<{
  finalObservation?: RequestObservation;
}>;
