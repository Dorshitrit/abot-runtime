import { normalizeCapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { createCapabilityResultCompactionSource } from "./capability-result-compaction-source.js";
import { projectSingleCopyOutputSummary } from "./capability-result-output-summary.js";
import type { RequestToolResult } from "./request-tool-results.js";
import { readStoredSourceMessage } from "./semantic-compaction/super-source-message.js";
import {
  createSemanticCompactionSha256Fingerprint,
  type SemanticCompactionSource,
} from "./semantic-compaction/contracts.js";

/** A transient compactor input; the caller retains the original stored identity. */
export function projectCompactionSourceInput(
  source: SemanticCompactionSource,
): SemanticCompactionSource {
  if (
    createSemanticCompactionSha256Fingerprint(source.content) !==
    source.sourceFingerprint
  )
    throw new Error("context_compaction_source_content_mismatch");
  const content =
    projectRegisteredReceiptInput(source) ??
    projectSupervisionSourceInput(source);
  if (content === undefined) return source;
  return Object.freeze({
    sourceRef: source.sourceRef,
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
}

function projectRegisteredReceiptInput(
  source: SemanticCompactionSource,
): string | undefined {
  const receipt = readCanonicalRegisteredReceipt(source);
  if (!receipt) return undefined;
  const singleCopy = projectReceiptInput(receipt);
  if (singleCopy === receipt) return undefined;
  return JSON.stringify(singleCopy);
}

function projectReceiptInput(receipt: RequestToolResult) {
  if (!hasRepresentedOutputReference(receipt))
    return projectSingleCopyOutputSummary(receipt);
  const { referenceData: _referenceData, ...singleCopy } = receipt;
  return projectSingleCopyOutputSummary(singleCopy);
}

function readCanonicalRegisteredReceipt(
  source: SemanticCompactionSource,
): RequestToolResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(source.content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (!hasCapabilitySourceReference(record.executionId, source.sourceRef))
    return undefined;
  const adapter = normalizeCapabilityAdapterResult(record.adapterResult);
  if (!adapter.ok) return undefined;
  if (adapter.value.kind !== "registered_tool_execution_result_v1")
    return undefined;
  const receipt = value as RequestToolResult;
  // Validate the remaining fields against the existing canonical serializer.
  // Payload sources retain aliases in their original bytes, including exact ones.
  const { referenceData: _referenceData, ...remaining } = receipt;
  if (
    createCapabilityResultCompactionSource(remaining).content !==
    JSON.stringify(remaining)
  )
    return undefined;
  if (JSON.stringify(receipt) !== source.content) return undefined;
  return receipt;
}

function hasRepresentedOutputReference(receipt: RequestToolResult): boolean {
  if (typeof receipt.referenceData !== "string") return false;
  if (!receipt.referenceData) return false;
  if (receipt.adapterResult?.kind !== "registered_tool_execution_result_v1")
    return false;
  const output = receipt.adapterResult.result.output;
  if (receipt.referenceData === output) return true;
  return receipt.referenceData === output.trim();
}

function hasCapabilitySourceReference(
  executionId: unknown,
  sourceRef: string,
): boolean {
  if (typeof executionId !== "string" || !executionId) return false;
  if (sourceRef === executionId) return true;
  // The existing payload scanner owns this explicit source identity.
  return sourceRef === `payload-result:${executionId}`;
}

function projectSupervisionSourceInput(
  source: SemanticCompactionSource,
): string | undefined {
  let message: ReturnType<typeof readStoredSourceMessage>;
  let record: Record<string, unknown> | undefined;
  try {
    message = readStoredSourceMessage(source);
    record = readRecord(JSON.parse(message.content));
  } catch {
    return undefined;
  }
  if (
    source.sourceRef !==
    `operation-supervision-evidence:${createSemanticCompactionSha256Fingerprint(message.content).slice(7)}`
  )
    return undefined;
  if (record?.kind !== "runtime_operation_supervision_evidence_v1")
    return undefined;
  if (record.authority !== "canonical_role_call_ledger") return undefined;
  if (!Array.isArray(record.entries)) return undefined;
  const originalEntries = record.entries;
  const entries = originalEntries.map(projectSupervisionEntryInput);
  if (entries.every((entry, index) => entry === originalEntries[index]))
    return undefined;
  return JSON.stringify({
    ...message,
    content: JSON.stringify({ ...record, entries }),
  });
}

function projectSupervisionEntryInput(value: unknown): unknown {
  const entry = readRecord(value);
  if (!entry) return value;
  const evidence = readRecord(entry.evidence);
  if (!evidence) return value;
  if (!isEmbeddedSupervisionResult(evidence.kind)) return value;
  const receipt = readRecord(evidence.receipt);
  if (!receipt) return value;
  if (entry.originExecutionId !== receipt.executionId) return value;
  const content = JSON.stringify({
    ...receipt,
    adapterResult: evidence.adapterResult,
  });
  const candidate = readCanonicalRegisteredReceipt({
    sourceRef:
      typeof receipt.executionId === "string" ? receipt.executionId : "",
    sourceFingerprint: createSemanticCompactionSha256Fingerprint(content),
    content,
  });
  if (!candidate) return value;
  const projected = projectReceiptInput(candidate);
  if (projected === candidate) return value;
  const { adapterResult: _adapterResult, ...singleCopy } = projected;
  return { ...entry, evidence: { ...evidence, receipt: singleCopy } };
}

function isEmbeddedSupervisionResult(kind: unknown): boolean {
  return (
    kind === "embedded_exact_result" ||
    kind === "embedded_cross_call_exact_result"
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}
