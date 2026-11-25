import type { ChatMessage } from "../../../model-gateway/types.js";
import { OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND } from "../../context/operation-supervision-evidence.js";
import {
  assertOperationSupervisionEvidenceContext,
  readOperationSupervisionEvidenceBinding,
} from "../../context/operation-supervision-evidence-binding.js";
import { isRequestToolResultsMessageBoundToView } from "../../context/request-tool-results-message-binding.js";
import { REQUEST_TOOL_RESULTS_MESSAGE_KIND } from "../../context/request-tool-results.js";
import type { WorkerResultAuthorSource } from "./contracts.js";
import type { WorkerEvidenceAssessmentReceipt } from "./evidence-assessment.js";

type RecordValue = Record<string, unknown>;
const DEPENDENCY_CARRIERS = new Set([
  "runtime_worker_assignment", "runtime_worker_capability_execution_assignment",
  "runtime_worker_result_assignment",
]);
const DEPENDENCY_FIELDS = [
  "resultRef", "producerCallId", "roleId", "outcome", "steeringVersion", "summary",
  "receipt", "observations", "semanticCheckpoints", "summaryProjection",
] as const;
const OUTCOME_FIELDS = [
  "executionId", "callId", "invocationAttempt", "capabilityId", "declaredEffect",
  "outcome", "observedEffect", "summaryProjection", "supersededByExecutionIds",
] as const;

/** Transfers the admitted evidence bytes; the accepted assessment remains model judgment. */
export function buildWorkerExecutionReport(
  source: WorkerResultAuthorSource,
  assessment: WorkerEvidenceAssessmentReceipt,
): string {
  assertReportBinding(source, assessment);
  const messages = source.handoffContextMessages ?? assessment.contextMessages;
  const requestToolResults = readVisibleToolResults(source);
  const dependencyResults = readVisibleDependencies(messages, source);
  const checkpoints = readVisibleCheckpoints(messages);
  const operationSupervision = readVisibleSupervision(messages, source, assessment);
  return JSON.stringify({
    kind: "runtime_worker_execution_report_v1",
    authority: "reference_data",
    callId: source.callId,
    parentCallId: source.parentCallId,
    invocationAttempt: source.invocationAttempt,
    sourceRevision: source.requestToolResults.sourceRevision,
    presenceEffect: "Transfers existing evidence only; the assessment is model judgment, not a new execution, verified completion, or action authority. Omitted detail is not evidence of absence.",
    assessment: { authority: "accepted_model_judgment", ...assessment.decision },
    executionOutcomes: projectOwnOutcomes(requestToolResults, source.callId),
    evidence: {
      ...(requestToolResults ? { requestToolResults } : {}),
      dependencyResults,
      ...(checkpoints.length ? { checkpoints } : {}),
      ...(operationSupervision ? { operationSupervision } : {}),
    },
  });
}

function assertReportBinding(source: WorkerResultAuthorSource, assessment: WorkerEvidenceAssessmentReceipt): void {
  const binding = assessment.binding;
  if (assessment.decision.requiresExecution || binding.callId !== source.callId ||
      binding.parentCallId !== source.parentCallId || binding.invocationAttempt !== source.invocationAttempt ||
      binding.sourceRevision !== source.requestToolResults.sourceRevision)
    throw new Error("worker_execution_report_assessment_binding_invalid");
}

function readVisibleToolResults(source: WorkerResultAuthorSource): RecordValue | undefined {
  const message = source.requestToolResultsContextMessage;
  if (!message) return undefined;
  const capsule = readRecordMessage(message);
  if (!Object.isFrozen(message) || !isRequestToolResultsMessageBoundToView(message, source.requestToolResults) ||
      capsule?.kind !== REQUEST_TOOL_RESULTS_MESSAGE_KIND ||
      capsule.sourceRevision !== source.requestToolResults.sourceRevision || !Array.isArray(capsule.results))
    throw new Error("worker_execution_report_tool_results_binding_invalid");
  // Preserve the current projection, including its deduplication, omissions and checkpoint receipts.
  return capsule;
}

function projectOwnOutcomes(capsule: RecordValue | undefined, callId: string): readonly RecordValue[] {
  if (!capsule) return [];
  const checkpoint = readRecord(capsule.semanticCheckpoint);
  const outcomes = new Map<string, RecordValue>();
  for (const result of [...readRecords(checkpoint?.coveredResults), ...readRecords(capsule.results)]) {
    if (result.callId !== callId || typeof result.executionId !== "string") continue;
    outcomes.set(result.executionId, pickFields(result, OUTCOME_FIELDS));
  }
  return [...outcomes.values()];
}

function readVisibleDependencies(messages: readonly ChatMessage[], source: WorkerResultAuthorSource): readonly RecordValue[] {
  const selected = new Map(source.dependencyResults.map((result) => [result.resultRef, result.producerCallId]));
  const visible = new Map<string, RecordValue>();
  for (const message of messages) {
    const capsule = readRecordMessage(message);
    if (!capsule || !DEPENDENCY_CARRIERS.has(String(capsule.kind)) ||
        capsule.callId !== source.callId || capsule.invocationAttempt !== source.invocationAttempt) continue;
    for (const result of readRecords(capsule.dependencyResults)) {
      if (typeof result.resultRef !== "string" || !selected.has(result.resultRef) ||
          selected.get(result.resultRef) !== result.producerCallId) continue;
      visible.set(result.resultRef, pickFields(result, DEPENDENCY_FIELDS));
    }
  }
  return [...visible.values()];
}

function readVisibleCheckpoints(messages: readonly ChatMessage[]): readonly RecordValue[] {
  const checkpoints = new Map<string, RecordValue>();
  for (const message of messages) {
    const capsule = readRecordMessage(message);
    if (capsule?.kind !== "runtime_semantic_compaction_checkpoint_v2") continue;
    checkpoints.set(JSON.stringify(capsule), capsule);
  }
  return [...checkpoints.values()];
}

function readVisibleSupervision(
  messages: readonly ChatMessage[], source: WorkerResultAuthorSource,
  assessment: WorkerEvidenceAssessmentReceipt,
): RecordValue | undefined {
  let visible: RecordValue | undefined;
  for (const message of messages) {
    const capsule = readRecordMessage(message);
    if (capsule?.kind !== OPERATION_SUPERVISION_EVIDENCE_MESSAGE_KIND) continue;
    const binding = readOperationSupervisionEvidenceBinding(message);
    if (!binding) throw new Error("worker_execution_report_supervision_binding_invalid");
    assertOperationSupervisionEvidenceContext(binding, {
      requestId: assessment.binding.requestId,
      call: { roleId: "worker", callId: source.callId, activationCount: source.invocationAttempt },
      sourceRevision: source.requestToolResults.sourceRevision, consumer: "worker.result",
    });
    visible = capsule;
  }
  return visible;
}

function pickFields(record: RecordValue, fields: readonly string[]): RecordValue {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
}

function readRecordMessage(message: ChatMessage): RecordValue | undefined {
  if (message.role !== "user") return undefined;
  try { return readRecord(JSON.parse(message.content)); } catch { return undefined; }
}

function readRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function readRecords(value: unknown): readonly RecordValue[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const record = readRecord(entry);
    return record ? [record] : [];
  }) : [];
}
