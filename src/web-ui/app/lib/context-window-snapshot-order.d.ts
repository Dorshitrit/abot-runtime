export type ContextEvidenceOrder = {
  eventSequence?: unknown;
  seqNo?: unknown;
  lastSeqNo?: unknown;
  sequenceDomain?: unknown;
  replayDomain?: unknown;
  replayOrder?: unknown;
};
export declare function compareContextEvidence(
  previous: ContextEvidenceOrder | null | undefined,
  incoming: ContextEvidenceOrder,
): number | null;
export declare function hasOrderedContextEvidence(
  event: ContextEvidenceOrder,
): boolean;
export declare function canReplaceContextWindowEvidence(
  previous: ContextEvidenceOrder | null | undefined,
  incoming: ContextEvidenceOrder,
): boolean;
export declare function isEventAfterContextWindowSnapshot(
  snapshot: ContextEvidenceOrder,
  event: ContextEvidenceOrder,
): boolean;
