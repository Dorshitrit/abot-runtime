import type { MemoryCandidate } from "./contracts.js";

export type ObservationMemoryProposal = MemoryCandidate &
  Readonly<{
    observationIds: readonly string[];
    reason: string;
    certainty: "observed" | "inferred";
  }>;

export type ObservationMemorySource = Readonly<{
  kind: "passive_observation";
  environmentId: string;
  deviceId: string;
  batchId: string;
  observationIds: readonly string[];
  observedAt: string;
  reason: string;
  certainty: "observed" | "inferred";
}>;

export type ObservationMemoryReceipt = Readonly<{
  batchId: string;
  recordIds: readonly string[];
  candidateIds?: readonly string[];
  createdAt: string;
  expiresAt?: string;
}>;

export type SaveObservationMemoryInput = Readonly<{
  batchId: string;
  batchExpiresAt: string;
  environmentId: string;
  proposals: readonly ObservationMemoryProposal[];
  observations: readonly Readonly<{
    id: string;
    deviceId: string;
    timestamp: string;
    revisitsObservationId?: string;
    revisit?: Readonly<{ firstObservedAt: string; contentUnchanged: true }>;
  }>[];
  abortSignal: AbortSignal;
}>;
