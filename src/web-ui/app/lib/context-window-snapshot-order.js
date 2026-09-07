function positiveSequence(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function comparableSequenceDifference(previous, incoming) {
  const previousOriginal = positiveSequence(previous?.eventSequence);
  const incomingOriginal = positiveSequence(incoming?.eventSequence);
  if (previousOriginal !== null && incomingOriginal !== null) {
    return incomingOriginal - previousOriginal;
  }
  const previousTransport = positiveSequence(
    previous?.seqNo ?? previous?.lastSeqNo,
  );
  const incomingTransport = positiveSequence(
    incoming?.seqNo ?? incoming?.lastSeqNo,
  );
  if (previousTransport === null || incomingTransport === null) return null;
  return incomingTransport - previousTransport;
}

export function canReplaceContextWindowEvidence(previous, incoming) {
  const difference = comparableSequenceDifference(previous, incoming);
  if (difference === null) return true;
  return difference > 0;
}

export function isEventAfterContextWindowSnapshot(snapshot, event) {
  const difference = comparableSequenceDifference(snapshot, event);
  if (difference === null) return false;
  return difference > 0;
}
