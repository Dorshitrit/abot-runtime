type CapabilityBatchSelectionCandidate = Readonly<{
  capabilityId: string;
}>;

/**
 * Full invocation identity is available only after controls and payloads are
 * materialized. Any offered observation capability can therefore participate
 * in a batch; exact duplicates are coalesced at execution admission.
 */
export function canOfferWorkerCapabilityBatchSelection(
  capabilities: readonly CapabilityBatchSelectionCandidate[],
): boolean {
  return capabilities.length > 0;
}
