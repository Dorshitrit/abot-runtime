function positiveSequence(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function compareContextEvidence(previous, incoming) {
  const previousOriginal = positiveSequence(previous?.eventSequence);
  const incomingOriginal = positiveSequence(incoming?.eventSequence);
  if (previousOriginal !== null && incomingOriginal !== null) {
    return incomingOriginal - previousOriginal;
  }
  if (previous?.sequenceDomain !== incoming?.sequenceDomain) return null;
  const previousTransport = positiveSequence(
    previous?.seqNo ?? previous?.lastSeqNo,
  );
  const incomingTransport = positiveSequence(
    incoming?.seqNo ?? incoming?.lastSeqNo,
  );
  if (previousTransport !== null && incomingTransport !== null) {
    return incomingTransport - previousTransport;
  }
  if (
    !previous?.replayDomain ||
    previous.replayDomain !== incoming?.replayDomain
  )
    return null;
  const previousReplay = positiveSequence(previous.replayOrder);
  const incomingReplay = positiveSequence(incoming.replayOrder);
  if (previousReplay === null || incomingReplay === null) return null;
  return incomingReplay - previousReplay;
}

export function hasOrderedContextEvidence(event) {
  if (positiveSequence(event?.eventSequence) !== null) return true;
  if (positiveSequence(event?.seqNo ?? event?.lastSeqNo) !== null) return true;
  return Boolean(
    event?.replayDomain && positiveSequence(event.replayOrder) !== null,
  );
}

export function canReplaceContextWindowEvidence(previous, incoming) {
  if (!previous) return true;
  const difference = compareContextEvidence(previous, incoming);
  if (difference !== null) return difference > 0;
  if (hasOrderedContextEvidence(previous)) return false;
  return hasOrderedContextEvidence(incoming);
}

export function isEventAfterContextWindowSnapshot(snapshot, event) {
  const difference = compareContextEvidence(snapshot, event);
  return difference !== null && difference > 0;
}
