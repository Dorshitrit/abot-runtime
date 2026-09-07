interface ContextWindowSequence {
  eventSequence?: unknown;
  seqNo?: unknown;
  lastSeqNo?: unknown;
}

export declare function canReplaceContextWindowEvidence(
  previous: ContextWindowSequence | null | undefined,
  incoming: ContextWindowSequence,
): boolean;

export declare function isEventAfterContextWindowSnapshot(
  snapshot: ContextWindowSequence,
  event: ContextWindowSequence,
): boolean;
