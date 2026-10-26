import type { RoleCallFrame, RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { buildBasketReferenceMessage, basketReferenceSourceRef } from "../../information-basket/reference-context.js";
import { toBasketReferenceStorageMessage } from "../../information-basket/reference-storage.js";
import { CompactionSourceInvariantError } from "../compaction-source-invariant.js";
import type { SemanticCompactionSource } from "./contracts.js";

/** Restore uses captured ledger bytes, never a fresh source read or index search. */
export function assertBasketReferenceSource(params: Readonly<{
  source: SemanticCompactionSource;
  head: RoleCallLedgerHead;
  scopeCall?: RoleCallFrame;
}>): void {
  const { source, head, scopeCall } = params;
  const reference = head.state.basketReferences?.find((entry) =>
    source.sourceRef === basketReferenceSourceRef(entry.referenceId));
  if (!reference) throw changed(source);
  if (reference.callId !== head.state.rootCallId) throw changed(source);
  if (scopeCall && scopeCall.callId !== head.state.rootCallId) throw changed(source);
  if (source.sourceRef !== basketReferenceSourceRef(reference.referenceId)) throw changed(source);
  const canonical = toBasketReferenceStorageMessage(buildBasketReferenceMessage(head.state.requestId, reference));
  if (source.content !== JSON.stringify(canonical)) throw changed(source);
}

function changed(source: SemanticCompactionSource) {
  return new CompactionSourceInvariantError("context_compaction_basket_reference_changed", source.sourceRef);
}
