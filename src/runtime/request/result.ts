import type { SessionMessageObservationMeta } from "../../sessions/types.js";
import type { MemoryCandidate } from "../long-term-memory/contracts.js";

export type RequestObservation = {
  observationMeta: SessionMessageObservationMeta;
  observationContent: string;
};

export type RequestOutputTextMode = "exact";

export type RequestRunnerResult = {
  output: string;
  /** Omission preserves the legacy normalized finalization contract. */
  outputTextMode?: RequestOutputTextMode;
  finalObservation?: RequestObservation;
  memoryCandidates?: readonly MemoryCandidate[];
};

export type RequestRoleExecutionHandoff = Readonly<{
  finalObservation?: RequestObservation;
}>;
