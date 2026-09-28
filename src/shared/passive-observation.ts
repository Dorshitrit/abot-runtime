/** Maximum replay lifetime of collected evidence, including paused batches. */
export const PASSIVE_OBSERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Passive desktop evidence. An edit describes a changed editable control, not authorship. */
export type PassiveObservationSource = Readonly<{
  app: string;
  processId?: number;
  windowId: string;
  documentId?: string;
  title?: string;
  url?: string;
}>;

export type PassiveObservation = Readonly<{
  id: string;
  timestamp: string;
  sequence: number;
  source: PassiveObservationSource;
  content: string;
  kind: "view" | "edit" | "activity";
  extraction: "uia" | "ax" | "atspi";
  coverage: "complete" | "partial" | "metadata_only";
  coverageReason?: string;
  revisitsObservationId?: string;
}>;

export type PassiveCollectionState =
  | "starting"
  | "collecting"
  | "partial"
  | "unavailable"
  | "permission_required"
  | "paused"
  | "stopped"
  | "disconnected"
  | "failed";

export type PassiveCollectorEvent =
  | Readonly<{ type: "observation"; observation: PassiveObservation }>
  | Readonly<{
      type: "status";
      state: PassiveCollectionState;
      reason?: string;
    }>;

/** Device identity is attached by the authenticated broker, never trusted from screen content. */
export type HostObservationEvent = PassiveCollectorEvent &
  Readonly<{ deviceId: string; ownerId: string; leaseId: string }>;

export type HostObservationSubscription = Readonly<{
  rootDir: string;
  ownerId: string;
  leaseId: string;
  abortSignal: AbortSignal;
  excludedApplications?: readonly string[];
  onEvent(event: HostObservationEvent): void;
}>;
