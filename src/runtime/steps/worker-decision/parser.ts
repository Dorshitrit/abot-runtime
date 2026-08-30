import {
  WORKER_DECISION_ACTIONS,
  type WorkerDecisionPhase,
  type WorkerDecisionDiagnosticContext,
  type WorkerDecisionParseResult,
  type WorkerDecisionValidationIssue,
} from "./contracts.js";
import {
  traceWorkerDecisionAccepted,
  traceWorkerDecisionRejected,
  traceWorkerEnvelopeAccepted,
  traceWorkerEnvelopeRejected,
} from "./diagnostics.js";
import type {
  WorkerCapabilityControls,
  WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import { buildAcceptedWorkerDecision } from "./parser/accepted-decision.js";
import {
  readWorkerDecisionAction,
  validateWorkerDecisionAction,
} from "./parser/action-validation.js";
import { readWorkerDecisionRecord } from "./parser/decision-shape-validation.js";
import { validatePendingSelectionOptions } from "./parser/pending-capability-selection-validation.js";
import type {
  DecisionValidationContext,
  WorkerDecisionAction,
} from "./parser/validation-contract.js";
import { createWorkerDecisionIssue } from "./parser/validation-contract.js";

export function parseWorkerDecisionOutput(
  text: string,
  diagnostic?: WorkerDecisionDiagnosticContext,
  options: Readonly<{
    availableCapabilities?: readonly WorkerCapabilityDescriptor[];
    maxBatchCapabilityExecutions?: number;
    decisionPhase?: WorkerDecisionPhase;
    allowedActions?: readonly WorkerDecisionAction[];
    pendingCapabilitySelection?: Readonly<{
      capabilityId: string;
      intent: string;
      authoringObjective?: string;
      selectionControls?: WorkerCapabilityControls;
    }>;
    pendingCapabilityBatchSelection?: readonly Readonly<{
      capabilityId: string;
      intent: string;
      authoringObjective?: string;
      selectionControls?: WorkerCapabilityControls;
    }>[];
  }> = {},
): WorkerDecisionParseResult {
  const decisionPhase = options.decisionPhase ?? "capability_selection";
  const pendingCapabilitySelection = options.pendingCapabilitySelection;
  const pendingCapabilityBatchSelection =
    options.pendingCapabilityBatchSelection;
  validatePendingSelectionOptions({
    decisionPhase,
    pendingCapabilitySelection,
    pendingCapabilityBatchSelection,
    availableCapabilities: options.availableCapabilities ?? [],
    maxBatchCapabilityExecutions: options.maxBatchCapabilityExecutions ?? 0,
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectWorkerDecisionEnvelope(
      text.length,
      [createWorkerDecisionIssue("worker_output_not_json", "decision")],
      diagnostic,
    );
  }
  const decodedRecord = readWorkerDecisionRecord(decoded);
  if (!decodedRecord) {
    return rejectWorkerDecisionEnvelope(
      text.length,
      [createWorkerDecisionIssue("worker_output_not_object", "decision")],
      diagnostic,
    );
  }
  const record = readStructuredDecisionEnvelope(decodedRecord);
  if (!record) {
    return rejectWorkerDecisionEnvelope(
      text.length,
      [createWorkerDecisionIssue("worker_output_envelope_invalid", "decision")],
      diagnostic,
    );
  }
  traceAcceptedWorkerDecisionEnvelope(record, text.length, diagnostic);

  const issues: WorkerDecisionValidationIssue[] = [];
  const selectedAction = readWorkerDecisionAction(record.action);
  const context: DecisionValidationContext = {
    decisionPhase,
    allowedActions: options.allowedActions ?? WORKER_DECISION_ACTIONS,
    pendingCapabilitySelection,
    pendingCapabilityBatchSelection,
    availableCapabilities: Array.isArray(options.availableCapabilities)
      ? options.availableCapabilities
      : [],
    maxBatchCapabilityExecutions: options.maxBatchCapabilityExecutions ?? 0,
  };
  const validation = validateWorkerDecisionAction(
    selectedAction,
    record,
    context,
    issues,
  );
  if (issues.length > 0 || !selectedAction) {
    traceRejectedWorkerDecision(selectedAction, issues, diagnostic);
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }

  const decision = buildAcceptedWorkerDecision(
    selectedAction,
    record,
    context,
    validation,
  );
  const accepted = deepFreeze(structuredClone(decision));
  if (diagnostic) {
    traceWorkerDecisionAccepted({ diagnostic, decision: accepted });
  }
  return { ok: true, decision: accepted };
}

function traceAcceptedWorkerDecisionEnvelope(
  record: Record<string, unknown>,
  outputLength: number,
  diagnostic: WorkerDecisionDiagnosticContext | undefined,
): void {
  if (!diagnostic) return;
  traceWorkerEnvelopeAccepted({
    diagnostic,
    outputLength,
    keyCount: Object.keys(record).length,
  });
}

function traceRejectedWorkerDecision(
  selectedAction: WorkerDecisionAction | undefined,
  issues: readonly WorkerDecisionValidationIssue[],
  diagnostic: WorkerDecisionDiagnosticContext | undefined,
): void {
  if (!diagnostic) return;
  traceWorkerDecisionRejected({
    diagnostic,
    issues,
    ...(selectedAction ? { selectedAction } : {}),
  });
}

function rejectWorkerDecisionEnvelope(
  outputLength: number,
  issues: readonly WorkerDecisionValidationIssue[],
  diagnostic?: WorkerDecisionDiagnosticContext,
): WorkerDecisionParseResult {
  if (diagnostic) {
    traceWorkerEnvelopeRejected({ diagnostic, outputLength, issues });
  }
  return {
    ok: false,
    stage: "json_envelope",
    issues: Object.freeze([...issues]),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
