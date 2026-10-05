import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  createSemanticCompactionSha256Fingerprint as hash,
  type SemanticCompactionSource,
} from "./contracts.js";
import type { RequestContextCompactionStore } from "./store.js";
import { readStoredSourceMessage } from "./super-source-message.js";

/**
 * Retains historical Reviewer evidence under its existing guarantees.
 * Old bounded appendices do not encode their producing call/projection revision;
 * do not invent that provenance by reconstructing today's Reviewer snapshot.
 * Checkpoint applicability, allowed consumers and result lineage are validated
 * by the checkpoint/dependency owners before this stored message is exposed.
 */
export function assertHistoricalReviewerSource(params: {
  source: SemanticCompactionSource;
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  store: RequestContextCompactionStore;
}): void {
  const { source, call } = params;
  if (call.roleId !== "reviewer")
    throw new Error("context_compaction_source_family_not_owned");
  const message = readStoredSourceMessage(source);
  const boundary = message.content.indexOf(
    "\nBEGIN BOUNDED EVIDENCE CONTENT\n",
  );
  if (
    boundary < 0 ||
    !message.content.endsWith("\nEND BOUNDED EVIDENCE CONTENT")
  )
    throw new Error("context_compaction_reviewer_source_invalid");
  let header;
  try {
    header = JSON.parse(message.content.slice(0, boundary));
  } catch {
    throw new Error("context_compaction_reviewer_source_invalid");
  }
  if (
    header.kind !== "runtime_reviewer_evidence_v1" ||
    header.authority !== "reference_data"
  )
    throw new Error("context_compaction_reviewer_source_invalid");
  const evidenceRef =
    typeof header.evidenceRef === "string"
      ? header.evidenceRef.trim()
      : undefined;
  const expectedRef = evidenceRef
    ? `reviewer-evidence:${evidenceRef}`
    : `reviewer-evidence:${hash(message.content).slice(7)}`;
  if (source.sourceRef !== expectedRef)
    throw new Error("context_compaction_reviewer_source_invalid");
}
