import {
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  WORKER_DECISION_ACTIONS,
  WORKER_RESULT_MAX_LENGTH,
  type WorkerControlDecision,
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
import {
  mergeWorkerCapabilityControls,
  partitionWorkerCapabilityControlsSchema,
  validateWorkerCapabilityRemainingControls,
  validateWorkerCapabilitySelectionControls,
  type WorkerCapabilityControls,
  type WorkerCapabilityControlsPartition,
  type WorkerCapabilityDescriptor,
  type WorkerCapabilityControlsSchema,
} from "../../orchestration/worker-capabilities/index.js";
import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import { workerCapabilityBatchExecutionSlotId } from "./format.js";

type WorkerDecisionAction = WorkerControlDecision["action"];

type PendingCapabilityInvocation = Readonly<{
  capabilityId: string;
  intent: string;
  selectionControls?: WorkerCapabilityControls;
}>;

type AcceptedCapabilityInvocation = Readonly<{
  capabilityId: string;
  intent: string;
  selectionControls?: WorkerCapabilityControls;
  controls?: WorkerCapabilityControls;
}>;

type DecisionValidationContext = Readonly<{
  decisionPhase: WorkerDecisionPhase;
  pendingCapabilitySelection?: PendingCapabilityInvocation;
  pendingCapabilityBatchSelection?: readonly PendingCapabilityInvocation[];
  availableCapabilities: readonly WorkerCapabilityDescriptor[];
  maxBatchCapabilityExecutions: number;
}>;

type ActionValidation = Readonly<{
  acceptedControls?: WorkerCapabilityControls;
  acceptedSelectionControls?: WorkerCapabilityControls;
  acceptedBatchInvocations?: readonly AcceptedCapabilityInvocation[];
}>;

type CapabilityInvocationValidation = Readonly<{
  selectedCapability?: WorkerCapabilityDescriptor;
  controlsPartition?: WorkerCapabilityControlsPartition;
  selectionControls?: WorkerCapabilityControls;
  controls?: WorkerCapabilityControls;
}>;

export function parseWorkerDecisionOutput(
  text: string,
  diagnostic?: WorkerDecisionDiagnosticContext,
  options: Readonly<{
    availableCapabilities?: readonly WorkerCapabilityDescriptor[];
    maxBatchCapabilityExecutions?: number;
    decisionPhase?: WorkerDecisionPhase;
    pendingCapabilitySelection?: Readonly<{
      capabilityId: string;
      intent: string;
      selectionControls?: WorkerCapabilityControls;
    }>;
    pendingCapabilityBatchSelection?: readonly Readonly<{
      capabilityId: string;
      intent: string;
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
    return rejectEnvelope(
      text.length,
      [issue("worker_output_not_json", "decision")],
      diagnostic,
    );
  }
  if (!asRecord(decoded)) {
    return rejectEnvelope(
      text.length,
      [issue("worker_output_not_object", "decision")],
      diagnostic,
    );
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record) {
    return rejectEnvelope(
      text.length,
      [issue("worker_output_envelope_invalid", "decision")],
      diagnostic,
    );
  }
  if (diagnostic) {
    traceWorkerEnvelopeAccepted({
      diagnostic,
      outputLength: text.length,
      keyCount: Object.keys(record).length,
    });
  }

  const issues: WorkerDecisionValidationIssue[] = [];
  const selectedAction = readWorkerDecisionAction(record.action);
  const context: DecisionValidationContext = {
    decisionPhase,
    pendingCapabilitySelection,
    pendingCapabilityBatchSelection,
    availableCapabilities: Array.isArray(options.availableCapabilities)
      ? options.availableCapabilities
      : [],
    maxBatchCapabilityExecutions: options.maxBatchCapabilityExecutions ?? 0,
  };
  let validation: ActionValidation = {};
  if (!selectedAction) {
    issues.push(issue("worker_action_invalid", "decision.action"));
  } else {
    validation = validateSelectedAction(
      selectedAction,
      record,
      context,
      issues,
    );
  }

  if (issues.length > 0 || !selectedAction) {
    if (diagnostic) {
      traceWorkerDecisionRejected({
        diagnostic,
        issues,
        ...(selectedAction ? { selectedAction } : {}),
      });
    }
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }

  const decision = buildAcceptedDecision(
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

function readWorkerDecisionAction(
  value: unknown,
): WorkerDecisionAction | undefined {
  return value === "return_result" ||
    value === "return_failure" ||
    value === "invoke_capability" ||
    value === "invoke_capabilities"
    ? value
    : undefined;
}

function validateSelectedAction(
  action: WorkerDecisionAction,
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  switch (action) {
    case "return_result":
      validateReturnResultDecision(record, issues);
      return {};
    case "return_failure":
      validateReturnFailureDecision(record, issues);
      return {};
    case "invoke_capability":
      return validateSingleCapabilityDecision(record, context, issues);
    case "invoke_capabilities":
      return validateCapabilityBatchDecision(record, context, issues);
  }
}

function validateReturnResultDecision(
  record: Record<string, unknown>,
  issues: WorkerDecisionValidationIssue[],
): void {
  exactKeys(record, ["action"], issues);
}

function validateReturnFailureDecision(
  record: Record<string, unknown>,
  issues: WorkerDecisionValidationIssue[],
): void {
  exactKeys(record, ["action", "reason"], issues);
  validateBoundedText(
    record.reason,
    WORKER_RESULT_MAX_LENGTH,
    "worker_result_invalid",
    "decision.reason",
    issues,
  );
}

function validateSingleCapabilityDecision(
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  if (
    context.decisionPhase === "capability_execution" &&
    !context.pendingCapabilitySelection
  ) {
    issues.push(
      issue("worker_capability_refinement_invalid", "decision.action"),
    );
  }
  const invocation = parseCapabilityInvocation(
    {
      record,
      path: "decision",
      includesActionKey: true,
      observationOnly: false,
      executionRequiresPendingInvocation: true,
      decisionPhase: context.decisionPhase,
      availableCapabilities: context.availableCapabilities,
      pendingInvocation: context.pendingCapabilitySelection,
      pendingSlotId: undefined,
    },
    issues,
  );
  return {
    acceptedControls: invocation.controls,
    acceptedSelectionControls: invocation.selectionControls,
  };
}

function validateCapabilityBatchDecision(
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  issues: WorkerDecisionValidationIssue[],
): ActionValidation {
  exactKeys(record, ["action", "invocations"], issues);
  const invocations =
    context.decisionPhase === "capability_execution"
      ? readPendingCapabilityBatchExecutionSlots(
          record.invocations,
          context.pendingCapabilityBatchSelection?.length,
        )
      : Array.isArray(record.invocations)
        ? record.invocations
        : undefined;
  if (!validCapabilityBatchSize(invocations, context)) {
    issues.push(
      issue("worker_capability_batch_size_invalid", "decision.invocations"),
    );
    return {};
  }

  const acceptedBatchInvocations: AcceptedCapabilityInvocation[] = [];
  invocations.forEach((input, index) => {
    const pendingSlotId =
      context.decisionPhase === "capability_execution"
        ? workerCapabilityBatchExecutionSlotId(index)
        : undefined;
    const path = pendingSlotId
      ? `decision.invocations.${pendingSlotId}`
      : `decision.invocations[${index}]`;
    const invocationRecord = asRecord(input);
    if (!invocationRecord) {
      issues.push(issue("worker_capability_batch_item_invalid", path));
      return;
    }
    const pendingInvocation =
      context.decisionPhase === "capability_execution"
        ? context.pendingCapabilityBatchSelection![index]
        : undefined;
    const invocation = parseCapabilityInvocation(
      {
        record: invocationRecord,
        path,
        includesActionKey: false,
        observationOnly: true,
        executionRequiresPendingInvocation: false,
        decisionPhase: context.decisionPhase,
        availableCapabilities: context.availableCapabilities,
        pendingInvocation,
        pendingSlotId,
      },
      issues,
    );
    if (
      invocation.selectedCapability?.effect === "observation" &&
      (pendingInvocation !== undefined ||
        validGeneratedCapabilityIdentity(invocationRecord)) &&
      (context.decisionPhase === "capability_execution"
        ? invocation.controls
        : invocation.controlsPartition?.selectionControlIds.length
          ? invocation.selectionControls
          : true)
    ) {
      acceptedBatchInvocations.push(
        Object.freeze({
          capabilityId:
            pendingInvocation?.capabilityId ??
            (invocationRecord.capabilityId as string),
          intent:
            pendingInvocation?.intent ??
            (invocationRecord.intent as string).trim(),
          ...(context.decisionPhase === "capability_execution"
            ? { controls: invocation.controls! }
            : invocation.selectionControls
              ? { selectionControls: invocation.selectionControls }
              : {}),
        }),
      );
    }
  });
  return { acceptedBatchInvocations };
}

function validCapabilityBatchSize(
  invocations: unknown[] | undefined,
  context: DecisionValidationContext,
): invocations is unknown[] {
  if (!invocations) return false;
  if (context.decisionPhase === "capability_execution") {
    return (
      context.pendingCapabilityBatchSelection !== undefined &&
      invocations.length === context.pendingCapabilityBatchSelection.length
    );
  }
  return (
    invocations.length >= 2 &&
    Number.isInteger(context.maxBatchCapabilityExecutions) &&
    context.maxBatchCapabilityExecutions >= 2 &&
    invocations.length <= context.maxBatchCapabilityExecutions
  );
}

function validGeneratedCapabilityIdentity(
  invocation: Record<string, unknown>,
): boolean {
  return (
    typeof invocation.capabilityId === "string" &&
    typeof invocation.intent === "string" &&
    invocation.intent.trim().length > 0 &&
    invocation.intent.length <= WORKER_CAPABILITY_INTENT_MAX_LENGTH
  );
}

function parseCapabilityInvocation(
  params: Readonly<{
    record: Record<string, unknown>;
    path: string;
    includesActionKey: boolean;
    observationOnly: boolean;
    executionRequiresPendingInvocation: boolean;
    decisionPhase: WorkerDecisionPhase;
    availableCapabilities: readonly WorkerCapabilityDescriptor[];
    pendingInvocation: PendingCapabilityInvocation | undefined;
    pendingSlotId: string | undefined;
  }>,
  issues: WorkerDecisionValidationIssue[],
): CapabilityInvocationValidation {
  let selectedCapability: WorkerCapabilityDescriptor | undefined;
  if (params.pendingInvocation) {
    selectedCapability = params.availableCapabilities.find(
      (capability) =>
        capability.capabilityId === params.pendingInvocation!.capabilityId,
    );
  } else if (
    params.decisionPhase === "capability_execution" &&
    params.executionRequiresPendingInvocation
  ) {
    selectedCapability = undefined;
  } else if (typeof params.record.capabilityId !== "string") {
    issues.push(
      issue("worker_capability_id_invalid", `${params.path}.capabilityId`),
    );
  } else if (
    !(selectedCapability = params.availableCapabilities.find(
      (capability) => capability.capabilityId === params.record.capabilityId,
    ))
  ) {
    issues.push(
      issue("worker_capability_unavailable", `${params.path}.capabilityId`),
    );
  } else if (
    params.observationOnly &&
    selectedCapability.effect !== "observation"
  ) {
    issues.push(
      issue(
        "worker_capability_batch_effect_invalid",
        `${params.path}.capabilityId`,
      ),
    );
  }

  if (params.decisionPhase === "capability_selection") {
    validateBoundedText(
      params.record.intent,
      WORKER_CAPABILITY_INTENT_MAX_LENGTH,
      "worker_capability_intent_invalid",
      `${params.path}.intent`,
      issues,
    );
  }

  const controlsPartition = partitionCapabilityControls(
    selectedCapability,
    `${params.path}.capabilityId`,
    issues,
  );
  exactKeys(
    params.record,
    expectedCapabilityInvocationKeys(params, controlsPartition),
    issues,
    params.path,
  );

  const selectionControls = validateSelectionControls(
    params,
    selectedCapability,
    controlsPartition,
    issues,
  );
  const controls = validateExecutionControls(
    params,
    selectedCapability,
    controlsPartition,
    issues,
  );
  return {
    selectedCapability,
    controlsPartition,
    selectionControls,
    controls,
  };
}

function partitionCapabilityControls(
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  capabilityPath: string,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityControlsPartition | undefined {
  if (!selectedCapability) return undefined;
  const partition = partitionWorkerCapabilityControlsSchema(
    selectedCapability.controls,
    selectedCapability.selectionControlIds,
  );
  if (!partition.ok) {
    issues.push(
      issue("worker_capability_controls_schema_invalid", capabilityPath),
    );
    return undefined;
  }
  return partition.value;
}

function expectedCapabilityInvocationKeys(
  params: Readonly<{
    includesActionKey: boolean;
    decisionPhase: WorkerDecisionPhase;
  }>,
  controlsPartition: WorkerCapabilityControlsPartition | undefined,
): string[] {
  const actionKey = params.includesActionKey ? ["action"] : [];
  if (params.decisionPhase === "capability_execution") {
    return [...actionKey, "controls"];
  }
  return [
    ...actionKey,
    "capabilityId",
    "intent",
    ...(controlsPartition?.selectionControlIds.length
      ? ["selectionControls"]
      : []),
  ];
}

function validateSelectionControls(
  params: Readonly<{
    record: Record<string, unknown>;
    path: string;
    observationOnly: boolean;
    decisionPhase: WorkerDecisionPhase;
    pendingSlotId: string | undefined;
  }>,
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  controlsPartition: WorkerCapabilityControlsPartition | undefined,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityControls | undefined {
  if (
    !selectedCapability ||
    (params.observationOnly && selectedCapability.effect !== "observation") ||
    !controlsPartition ||
    params.decisionPhase !== "capability_selection" ||
    controlsPartition.selectionControlIds.length === 0
  ) {
    return undefined;
  }
  const selectionControls = validateWorkerCapabilitySelectionControls(
    controlsPartition,
    normalizeGeneratedCapabilityControls(
      params.record.selectionControls,
      controlsPartition.selectionSchema,
    ),
  );
  if (!selectionControls.ok) {
    issues.push(
      workerCapabilityControlsIssue({
        issueCode: selectionControls.issueCode,
        controlId: selectionControls.controlId,
        path: selectionControls.controlId
          ? `${params.path}.selectionControls.${selectionControls.controlId}`
          : `${params.path}.selectionControls`,
        capability: selectedCapability,
        schema: controlsPartition.selectionSchema,
        pendingSlotId: params.pendingSlotId,
      }),
    );
    return undefined;
  }
  return selectionControls.value;
}

function validateExecutionControls(
  params: Readonly<{
    record: Record<string, unknown>;
    path: string;
    observationOnly: boolean;
    decisionPhase: WorkerDecisionPhase;
    pendingInvocation: PendingCapabilityInvocation | undefined;
    pendingSlotId: string | undefined;
  }>,
  selectedCapability: WorkerCapabilityDescriptor | undefined,
  controlsPartition: WorkerCapabilityControlsPartition | undefined,
  issues: WorkerDecisionValidationIssue[],
): WorkerCapabilityControls | undefined {
  if (
    selectedCapability &&
    (!params.observationOnly || selectedCapability.effect === "observation") &&
    controlsPartition &&
    params.decisionPhase === "capability_execution"
  ) {
    const remainingControls = validateWorkerCapabilityRemainingControls(
      controlsPartition,
      normalizeGeneratedCapabilityControls(
        params.record.controls,
        controlsPartition.remainingSchema,
      ),
    );
    const mergedControls = remainingControls.ok
      ? mergeWorkerCapabilityControls(controlsPartition, {
          selectionControls: params.pendingInvocation?.selectionControls ?? {},
          remainingControls: remainingControls.value,
        })
      : remainingControls;
    if (!mergedControls.ok) {
      issues.push(
        workerCapabilityControlsIssue({
          issueCode: mergedControls.issueCode,
          controlId: mergedControls.controlId,
          path: mergedControls.controlId
            ? `${params.path}.controls.${mergedControls.controlId}`
            : `${params.path}.controls`,
          capability: selectedCapability,
          schema: controlsPartition.remainingSchema,
          pendingSlotId: params.pendingSlotId,
        }),
      );
      return undefined;
    }
    return mergedControls.value;
  }
  if (
    params.decisionPhase === "capability_execution" &&
    !asRecord(params.record.controls)
  ) {
    issues.push(
      issue("worker_capability_controls_not_object", `${params.path}.controls`),
    );
  }
  return undefined;
}

function buildAcceptedDecision(
  action: WorkerDecisionAction,
  record: Record<string, unknown>,
  context: DecisionValidationContext,
  validation: ActionValidation,
): WorkerControlDecision {
  if (action === "return_result") {
    return { action: "return_result" };
  }
  if (action === "return_failure") {
    return {
      action: "return_failure",
      reason: (record.reason as string).trim(),
    };
  }
  if (action === "invoke_capability") {
    return {
      action: "invoke_capability",
      capabilityId:
        context.pendingCapabilitySelection?.capabilityId ??
        (record.capabilityId as string),
      intent:
        context.pendingCapabilitySelection?.intent ??
        (record.intent as string).trim(),
      ...(context.decisionPhase === "capability_execution"
        ? { controls: validation.acceptedControls! }
        : validation.acceptedSelectionControls
          ? { selectionControls: validation.acceptedSelectionControls }
          : {}),
    };
  }
  return {
    action: "invoke_capabilities",
    invocations: Object.freeze(
      validation.acceptedBatchInvocations!.map((invocation) =>
        context.decisionPhase === "capability_execution"
          ? Object.freeze({
              capabilityId: invocation.capabilityId,
              intent: invocation.intent,
              controls: invocation.controls!,
            })
          : Object.freeze({
              capabilityId: invocation.capabilityId,
              intent: invocation.intent,
              ...(invocation.selectionControls
                ? { selectionControls: invocation.selectionControls }
                : {}),
            }),
      ),
    ),
  };
}

function readPendingCapabilityBatchExecutionSlots(
  value: unknown,
  expectedCount: number | undefined,
): unknown[] | undefined {
  const record = asRecord(value);
  if (!record || expectedCount === undefined) return undefined;
  const slotIds = Array.from({ length: expectedCount }, (_, index) =>
    workerCapabilityBatchExecutionSlotId(index),
  );
  const actualSlotIds = Object.keys(record);
  if (
    actualSlotIds.length !== slotIds.length ||
    actualSlotIds.some((slotId) => !slotIds.includes(slotId))
  ) {
    return undefined;
  }
  return slotIds.map((slotId) => record[slotId]);
}

function validatePendingSelectionOptions(
  options: Readonly<{
    decisionPhase: WorkerDecisionPhase;
    pendingCapabilitySelection?: Readonly<{
      capabilityId: string;
      intent: string;
      selectionControls?: WorkerCapabilityControls;
    }>;
    pendingCapabilityBatchSelection?: readonly Readonly<{
      capabilityId: string;
      intent: string;
      selectionControls?: WorkerCapabilityControls;
    }>[];
    availableCapabilities: readonly WorkerCapabilityDescriptor[];
    maxBatchCapabilityExecutions: number;
  }>,
): void {
  const hasSingle = options.pendingCapabilitySelection !== undefined;
  const hasBatch = options.pendingCapabilityBatchSelection !== undefined;
  if (options.decisionPhase === "capability_selection") {
    if (hasSingle || hasBatch) {
      throw new Error("worker_pending_capability_selection_unexpected");
    }
    return;
  }
  if (hasSingle === hasBatch) {
    throw new Error("worker_pending_capability_selection_invalid");
  }
  if (options.pendingCapabilitySelection) {
    const pending = options.pendingCapabilitySelection;
    const descriptor = options.availableCapabilities.find(
      ({ capabilityId }) => capabilityId === pending.capabilityId,
    );
    if (
      pending.intent.trim() !== pending.intent ||
      pending.intent.length === 0 ||
      pending.intent.length > WORKER_CAPABILITY_INTENT_MAX_LENGTH ||
      !descriptor ||
      !validPendingSelectionControls(pending, descriptor)
    ) {
      throw new Error("worker_pending_capability_selection_invalid");
    }
    return;
  }
  const pendingBatch = options.pendingCapabilityBatchSelection!;
  if (
    !Array.isArray(pendingBatch) ||
    pendingBatch.length < 2 ||
    !Number.isInteger(options.maxBatchCapabilityExecutions) ||
    pendingBatch.length > options.maxBatchCapabilityExecutions ||
    pendingBatch.some((pending) => {
      const descriptor = options.availableCapabilities.find(
        ({ capabilityId }) => capabilityId === pending.capabilityId,
      );
      return (
        !descriptor ||
        descriptor.effect !== "observation" ||
        pending.intent.trim() !== pending.intent ||
        pending.intent.length === 0 ||
        pending.intent.length > WORKER_CAPABILITY_INTENT_MAX_LENGTH ||
        !validPendingSelectionControls(pending, descriptor)
      );
    })
  ) {
    throw new Error("worker_pending_capability_batch_selection_invalid");
  }
}

function validPendingSelectionControls(
  pending: Readonly<{
    selectionControls?: WorkerCapabilityControls;
  }>,
  descriptor: WorkerCapabilityDescriptor,
): boolean {
  const partition = partitionWorkerCapabilityControlsSchema(
    descriptor.controls,
    descriptor.selectionControlIds,
  );
  if (!partition.ok) return false;
  const expected = partition.value.selectionControlIds.length > 0;
  return (
    Object.hasOwn(pending, "selectionControls") === expected &&
    validateWorkerCapabilitySelectionControls(
      partition.value,
      pending.selectionControls ?? {},
    ).ok
  );
}

function rejectEnvelope(
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

function exactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  issues: WorkerDecisionValidationIssue[],
  path = "decision",
): void {
  const expected = new Set(expectedKeys);
  const actual = Object.keys(record);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    issues.push(issue("worker_decision_shape_invalid", path));
  }
}

function normalizeGeneratedCapabilityControls(
  value: unknown,
  schema: WorkerCapabilityControlsSchema,
): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const required = new Set(schema.required);
  return Object.fromEntries(
    Object.entries(record).filter(
      ([controlId, controlValue]) =>
        controlValue !== null ||
        required.has(controlId) ||
        !Object.prototype.hasOwnProperty.call(schema.properties, controlId),
    ),
  );
}

function validateBoundedText(
  value: unknown,
  maximumLength: number,
  code: string,
  path: string,
  issues: WorkerDecisionValidationIssue[],
): void {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    normalized.length === 0 ||
    value.length > maximumLength
  ) {
    issues.push(issue(code, path));
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function workerCapabilityControlsIssue(
  params: Readonly<{
    issueCode: string;
    controlId: string | undefined;
    path: string;
    capability: WorkerCapabilityDescriptor;
    schema: WorkerCapabilityControlsSchema;
    pendingSlotId: string | undefined;
  }>,
): WorkerDecisionValidationIssue {
  const code = `worker_capability_${params.issueCode}`;
  if (
    params.issueCode !== "controls_unknown" &&
    params.issueCode !== "controls_required_missing"
  ) {
    return issue(code, params.path);
  }
  const pendingBinding = params.pendingSlotId
    ? `Pending slot ${JSON.stringify(params.pendingSlotId)} is frozen to capabilityId ${JSON.stringify(params.capability.capabilityId)}.`
    : `Pending capabilityId is ${JSON.stringify(params.capability.capabilityId)}.`;
  const problem =
    params.issueCode === "controls_unknown"
      ? `Control ${JSON.stringify(params.controlId)} is not allowed for this capability.`
      : `Required control ${JSON.stringify(params.controlId)} is missing for this capability.`;
  return issue(
    code,
    params.path,
    `${pendingBinding} ${problem} Allowed control IDs: ${JSON.stringify(Object.keys(params.schema.properties))}. Required control IDs: ${JSON.stringify(params.schema.required)}.`,
  );
}

function issue(
  code: string,
  path: string,
  message?: string,
): WorkerDecisionValidationIssue {
  return {
    code,
    path,
    message:
      message ??
      (code === "worker_action_invalid"
        ? `Action must be one of: ${WORKER_DECISION_ACTIONS.join(", ")}.`
        : `Worker decision failed ${code}.`),
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
