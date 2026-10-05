import type {
  ContextInputMeasurement,
  ContextProviderCounts,
} from "./context-window-measurement.js";
import type {
  ContextCompactionArrow,
  ContextCompactionCycle,
} from "./context-compaction-state.js";
export type ContextEvidenceScope = Readonly<{
  requestId: string;
  environmentId: string;
  sessionId: string;
  viewVersion?: number;
  generation: string;
  generationSource?: "lifecycle" | "event" | "legacy";
  requestKnown: boolean;
  acceptedLifecycle?: boolean;
}>;
export type ContextSnapshotIdentity = Record<string, unknown> & {
  requestId: string;
  generation: string;
  invocationId: string;
  modelStep: string;
  profileId: string;
  admissionOutcome: string;
};
export type ContextSnapshotObservation = ContextSnapshotIdentity &
  (
    | { availability: "available"; measurement: ContextInputMeasurement }
    | { availability: "unavailable"; measurement: null }
  );
export type ContextProviderUsage = ContextProviderCounts &
  Record<string, unknown> & { invocationId: string; source: string };
export type ContextWindowDisplay = ContextSnapshotIdentity &
  ContextInputMeasurement & {
    availability: "available";
    providerUsage: ContextProviderUsage | null;
    compaction: ContextCompactionArrow | null;
  };
export type ContextWindowState = Record<string, unknown> &
  ContextEvidenceScope & {
    latestSnapshotObservation: ContextSnapshotObservation | null;
    lastValidSnapshot: ContextSnapshotObservation | null;
    snapshot:
      | (ContextSnapshotIdentity &
          ContextInputMeasurement & { availability: "available" })
      | null;
    providerUsage: ContextProviderUsage | null;
    usageByInvocation: Map<string, ContextProviderUsage>;
    cycles: Map<string, ContextCompactionCycle>;
    requestTerminal: Record<string, unknown> | null;
    pendingCompaction: ContextCompactionCycle | null;
    lastCompaction: ContextCompactionArrow | null;
    lastCompactionEvent: Record<string, unknown> | null;
    openCompactionCount: number;
  };
export declare function contextEvidenceScope(
  state: Record<string, unknown>,
  environmentId: string,
  requestId: string,
): ContextEvidenceScope;
export declare function reduceContextWindowEvidence(
  previous: ContextWindowState | undefined,
  message: Record<string, unknown>,
  scope: ContextEvidenceScope,
): ContextWindowState | undefined;
export declare function synchronizeContextRequestLifecycle(
  state: Record<string, unknown>,
  message: Record<string, unknown>,
  environmentId: string,
): void;
export declare function projectContextWindowDisplay(
  contextWindow: unknown,
  requestId: string,
): ContextWindowDisplay | null;

export declare function contextEvidenceOrder(
  message: Record<string, unknown>,
  scope: ContextEvidenceScope,
): Record<string, unknown>;
