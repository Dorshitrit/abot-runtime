import {
  enforcePluginResultByteBudget,
  type ResolvedRuntimeToolPath,
  type ToolImplementationOutput,
  type ToolResultBudget,
} from "../../../src/plugin-sdk/index.js";
import type { MutationSnapshot } from "../../filesystem/source/bounded-io.js";
import type { CommittedRangeReservation } from "./range-references.js";
import { readSnapshot, versionKey } from "./snapshot.js";

const UNAVAILABLE_REASON = "The edit completed, but its current file revision could not be confirmed. Read the desired range again.";

/** Assess both possible receipts before mutation; post-commit observation cannot turn a write into a failure. */
export function prepareCommittedRangeReceipt(
  result: ToolImplementationOutput,
  reservation: CommittedRangeReservation,
  budget?: ToolResultBudget,
) {
  const available = enforcePluginResultByteBudget({
    ...result,
    output: `${result.output}\nrange_ref: ${reservation.id}\nRange: exact replacement text in the current file.`,
    data: { ...result.data, range_ref: reservation.id },
  }, budget);
  if (!available.ok) return { failure: available };
  const unavailable = enforcePluginResultByteBudget({
    ...result,
    output: `${result.output}\nrange_ref unavailable: ${UNAVAILABLE_REASON}`,
    data: { ...result.data, range_ref_unavailable: UNAVAILABLE_REASON },
  }, budget);
  if (!unavailable.ok) return { failure: unavailable };
  return { available, unavailable };
}

/** A new reference observes the committed version; it never rebinds an older reference. */
export async function confirmCommittedRangeReference(input: Readonly<{
  reservation: CommittedRangeReservation;
  target: ResolvedRuntimeToolPath;
  content: string;
  unchangedSnapshot?: MutationSnapshot;
}>): Promise<boolean> {
  try {
    const current = input.unchangedSnapshot ?? await readSnapshot(input.target);
    if (!matchesCommittedContent(current, input.content)) return false;
    input.reservation.commit(versionKey(current.version));
    return true;
  } catch {
    // The write has already succeeded. Missing evidence must not report a failed write.
    return false;
  }
}

function matchesCommittedContent(snapshot: MutationSnapshot, content: string): boolean {
  if (snapshot.version.kind !== "file") return false;
  return snapshot.content === content;
}
