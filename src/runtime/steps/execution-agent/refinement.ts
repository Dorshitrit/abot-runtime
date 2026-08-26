import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  assessRequestMessagesBudget,
  projectRequestContext,
} from "../../context/request-context.js";
import { createExecutionAgentCompactionController } from "./compaction.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../context/request-source.js";
import { buildSessionArtifactPathsMessage } from "../../context/session-artifact-paths.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import { invokeStructuredModelStep } from "../../model/invoke-structured-step.js";
import {
  createStructuredDecisionEnvelopeSchema,
  readStructuredDecisionEnvelope,
} from "../../model/structured-decision-envelope.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  materializeCapabilityControlsIfComplete,
  mergeCapabilityControls,
  partitionCapabilityControlsSchema,
  type CapabilityControl,
  type CapabilityControls,
  type CapabilityControlsPartition,
  type CapabilityControlsSchema,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  type ExecutionAgentCapabilityInvocation,
} from "./contracts.js";
import { buildExecutionControlsRefinementInstructions } from "./refinement-prompt.js";
import {
  buildExecutionContinuationMessages,
  buildExecutionStateMessage,
} from "./state-context.js";

type PendingRefinement = Readonly<{
  index: number;
  invocation: ExecutionAgentCapabilityInvocation;
  descriptor: CapabilityDescriptor;
  partition: CapabilityControlsPartition;
  selectionControls: CapabilityControls;
  guidance: string;
}>;

export type RefinedExecutionCapabilityInvocation = Readonly<
  Omit<ExecutionAgentCapabilityInvocation, "controls"> & {
    controls: CapabilityControls;
  }
>;

export type ExecutionCapabilityRefinementOutcome =
  | Readonly<{
      disposition: "execute";
      invocations: readonly RefinedExecutionCapabilityInvocation[];
    }>
  | Readonly<{ disposition: "reconsider" }>;

type RefineExecutionCapabilityInvocationsOptions = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  capabilities: readonly CapabilityDescriptor[];
  eligibleSessionArtifactPaths: readonly string[];
  invocations: readonly ExecutionAgentCapabilityInvocation[];
  steeringSnapshot: RequestSteeringSnapshot;
}>;

type ParsedRefinementEntry =
  | Readonly<{
      index: number;
      disposition: "execute";
      controls: CapabilityControls;
    }>
  | Readonly<{ index: number; disposition: "reconsider" }>;

/**
 * Loads guidance for every selected capability, then asks the same Execution
 * Agent to confirm applicability or reconsider and to complete any remaining
 * controls. Capability identity, selection controls, and ordering remain
 * immutable. Client intent is retained separately for lifecycle presentation.
 * This is not a child-role call.
 */
export async function refineExecutionCapabilityInvocations(
  request: RequestExecutionScope,
  options: RefineExecutionCapabilityInvocationsOptions,
): Promise<ExecutionCapabilityRefinementOutcome> {
  if (options.invocations.length === 0) {
    throw new Error("execution_capability_refinement_empty");
  }
  const eligibleSessionArtifactPaths = options.eligibleSessionArtifactPaths;
  const prepared = options.invocations.map((invocation, index) => {
    const descriptor = options.capabilities.find(
      ({ capabilityId }) => capabilityId === invocation.capabilityId,
    );
    if (!descriptor) {
      throw new Error("execution_capability_refinement_descriptor_missing");
    }
    const partition = partitionCapabilityControlsSchema(
      descriptor.controls,
      descriptor.selectionControlIds,
    );
    if (!partition.ok) {
      throw new Error("execution_capability_refinement_schema_invalid");
    }
    const selectionControls = invocation.selectionControls ?? Object.freeze({});
    if (
      Object.keys(selectionControls).some((controlId) =>
        Object.hasOwn(partition.value.remainingSchema.properties, controlId),
      )
    ) {
      throw new Error("execution_capability_refinement_partition_drift");
    }
    const materialized = materializeCapabilityControlsIfComplete(
      partition.value,
      selectionControls,
    );
    if (materialized && !materialized.ok) {
      throw new Error("execution_capability_selection_controls_invalid");
    }
    return Object.freeze({
      index,
      invocation,
      descriptor,
      partition: partition.value,
      selectionControls,
      ...(materialized?.ok ? { controls: materialized.value } : {}),
    });
  });
  const guidanceByCapabilityId = new Map(
    await Promise.all(
      [
        ...new Set(prepared.map(({ descriptor }) => descriptor.capabilityId)),
      ].map(
        async (capabilityId) =>
          [
            capabilityId,
            (
              (await resolveRequestWorkerCapabilities(
                request,
              ).provider.getExecutionGuidance?.(capabilityId)) ?? ""
            ).trim(),
          ] as const,
      ),
    ),
  );
  const pending: readonly PendingRefinement[] = Object.freeze(
    prepared.flatMap((entry) => {
      const guidance =
        guidanceByCapabilityId.get(entry.descriptor.capabilityId) ?? "";
      if (entry.controls !== undefined && guidance.length === 0) return [];
      return [
        Object.freeze({
          index: entry.index,
          invocation: entry.invocation,
          descriptor: entry.descriptor,
          partition: entry.partition,
          selectionControls: entry.selectionControls,
          guidance,
        }),
      ];
    }),
  );
  if (pending.length === 0) {
    return executeOutcome(
      prepared.map(({ invocation, controls }) =>
        freezeInvocation(invocation, controls!),
      ),
    );
  }
  const format = createControlsRefinementFormat(pending);
  const instructions = buildExecutionControlsRefinementInstructions(
    pending.map(({ index, descriptor, guidance }) => ({
      slot: slotId(index),
      capabilityId: descriptor.capabilityId,
      guidance,
    })),
  );
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const callId = `execution-refinement-${options.head.revision + 1}`;
  const requestSource = projectRequestSource({
    requestId: request.requestId,
    prompt: request.prompt,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    callId,
    historyMessages: request.historyMessages,
  });
  const assignment = JSON.stringify({
    kind: "runtime_execution_capability_refinement_v1",
    authority: "runtime_state",
    stateRevision: options.head.revision,
    requestSourceRef: requestSource.sourceRef,
    workingDirectory: options.call.workingDirectory ?? null,
    invocations: pending.map(
      ({ index, invocation, descriptor, partition }) => ({
        slot: slotId(index),
        capabilityId: descriptor.capabilityId,
        selectionControls: invocation.selectionControls ?? {},
        remainingControls: partition.remainingSchema,
      }),
    ),
  });
  const continuationMessages = buildExecutionContinuationMessages(
    options.head,
    options.call,
  );
  const baseReferenceMessages = Object.freeze([
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    buildRequestSourceMessage(requestSource),
    buildExecutionStateMessage(options.head, options.call),
    ...appendRequestSteeringContext([], options.steeringSnapshot),
  ]);
  const currentMessage = {
    role: "user" as const,
    content: assignment,
    ...(request.attachments ? { attachments: request.attachments } : {}),
  };
  const sessionArtifactPathProjection = buildSessionArtifactPathsMessage({
    targets: eligibleSessionArtifactPaths,
    availableTargetCount: request.sessionArtifactPaths?.length ?? 0,
    applicable: pending.some(({ descriptor, partition }) =>
      (descriptor.runtimePathControlIds ?? []).some((controlId) =>
        Object.hasOwn(partition.remainingSchema.properties, controlId),
      ),
    ),
    maxTargets: 8,
    fits: (message) =>
      assessRequestMessagesBudget({
        messages: [
          { role: "system", content: instructions },
          message,
          ...baseReferenceMessages,
          currentMessage,
          ...continuationMessages,
        ],
        format,
        budget,
      }).fits,
  });
  const context = projectRequestContext({
    instructions,
    format,
    historyMessages: [],
    prompt: assignment,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    referenceMessages: [
      ...(sessionArtifactPathProjection
        ? [sessionArtifactPathProjection.message]
        : []),
      ...baseReferenceMessages,
    ],
    ...(continuationMessages.length > 0 ? { continuationMessages } : {}),
    budget,
    diagnostic: {
      requestId: request.requestId,
      modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
      callId,
    },
    onEvent: request.onEvent,
    deferCompactionFailure: true,
  });
  const refined = await invokeStructuredModelStep({
    request,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    format,
    messages: context.messages,
    contextCompaction: createExecutionAgentCompactionController(request, {
      call: options.call,
      sourceRevision: options.head.revision,
      allowedConsumers: Object.freeze([EXECUTION_AGENT_DECISION_MODEL_STEP]),
      scopeSuffix: "controls-refinement",
    }),
    timeoutReason: "execution_capability_refinement_timeout",
    invalidOutputReason: "invalid_execution_capability_refinement",
    parse: (text) => parseControlsRefinement(text, pending),
  });
  if (refined.some(({ disposition }) => disposition === "reconsider")) {
    return Object.freeze({ disposition: "reconsider" as const });
  }
  const byIndex = new Map<number, CapabilityControls>();
  for (const entry of refined) {
    if (entry.disposition === "execute") {
      byIndex.set(entry.index, entry.controls);
    }
  }
  return executeOutcome(
    prepared.map(({ index, invocation, controls }) =>
      freezeInvocation(invocation, controls ?? byIndex.get(index)!),
    ),
  );
}

function createControlsRefinementFormat(
  pending: readonly PendingRefinement[],
): ModelGatewayJsonSchemaFormat {
  const decision = exactObject({
    invocations: exactObject(
      Object.fromEntries(
        pending.map(({ index, partition }) => [
          slotId(index),
          {
            anyOf: [
              exactObject({
                disposition: literal("execute"),
                controls: projectControlsSchema(partition.remainingSchema),
              }),
              exactObject({ disposition: literal("reconsider") }),
            ],
          },
        ]),
      ),
    ),
  });
  const schema = createStructuredDecisionEnvelopeSchema([decision]);
  return {
    type: "json_schema",
    name: "execution_capability_controls",
    strict: true,
    postValidatedSchemaConstraints: collectMaxLengthConstraints(schema),
    schema,
  };
}

function parseControlsRefinement(
  text: string,
  pending: readonly PendingRefinement[],
):
  | Readonly<{
      ok: true;
      decision: readonly ParsedRefinementEntry[];
    }>
  | Readonly<{
      ok: false;
      stage: "json_envelope" | "domain_parser";
      issues: readonly Readonly<{
        code: string;
        path: string;
        message: string;
      }>[];
    }> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim());
  } catch {
    return refinementFailure("json_envelope", "output_not_json", "decision");
  }
  const decision = readStructuredDecisionEnvelope(decoded);
  const invocations = decision ? asRecord(decision.invocations) : undefined;
  if (
    !decision ||
    Object.keys(decision).length !== 1 ||
    !invocations ||
    Object.keys(invocations).length !== pending.length
  ) {
    return refinementFailure(
      "json_envelope",
      "refinement_envelope_invalid",
      "decision.invocations",
    );
  }
  const accepted: ParsedRefinementEntry[] = [];
  const issues: Array<
    Readonly<{ code: string; path: string; message: string }>
  > = [];
  for (const entry of pending) {
    const slot = asRecord(invocations[slotId(entry.index)]);
    if (!slot || typeof slot.disposition !== "string") {
      issues.push(
        refinementIssue("refinement_slot_invalid", slotId(entry.index)),
      );
      continue;
    }
    if (slot.disposition === "reconsider" && Object.keys(slot).length === 1) {
      accepted.push(
        Object.freeze({
          index: entry.index,
          disposition: "reconsider" as const,
        }),
      );
      continue;
    }
    if (
      slot.disposition !== "execute" ||
      Object.keys(slot).length !== 2 ||
      !("controls" in slot)
    ) {
      issues.push(
        refinementIssue("refinement_slot_invalid", slotId(entry.index)),
      );
      continue;
    }
    const remainingControls = normalizeNullableOptionalControls(
      slot.controls,
      entry.partition.remainingSchema,
    );
    const merged = mergeCapabilityControls(entry.partition, {
      selectionControls: entry.selectionControls,
      remainingControls,
    });
    if (!merged.ok) {
      issues.push(
        refinementIssue(
          `refinement_${merged.issueCode}`,
          `decision.invocations.${slotId(entry.index)}.controls${
            merged.controlId ? `.${merged.controlId}` : ""
          }`,
        ),
      );
      continue;
    }
    accepted.push(
      Object.freeze({
        index: entry.index,
        disposition: "execute" as const,
        controls: merged.value,
      }),
    );
  }
  if (issues.length > 0 || accepted.length !== pending.length) {
    return Object.freeze({
      ok: false as const,
      stage: "domain_parser" as const,
      issues: Object.freeze(issues),
    });
  }
  return Object.freeze({
    ok: true as const,
    decision: Object.freeze(accepted),
  });
}

function freezeInvocation(
  invocation: ExecutionAgentCapabilityInvocation,
  controls: CapabilityControls,
): RefinedExecutionCapabilityInvocation {
  if (!controls) throw new Error("execution_capability_controls_missing");
  return Object.freeze({
    capabilityId: invocation.capabilityId,
    intent: invocation.intent,
    ...(invocation.selectionControls
      ? { selectionControls: invocation.selectionControls }
      : {}),
    controls,
  });
}

function executeOutcome(
  invocations: readonly RefinedExecutionCapabilityInvocation[],
): ExecutionCapabilityRefinementOutcome {
  return Object.freeze({
    disposition: "execute" as const,
    invocations: Object.freeze([...invocations]),
  });
}

function projectControlsSchema(
  schema: CapabilityControlsSchema,
): Record<string, unknown> {
  const required = new Set(schema.required);
  return exactObject(
    Object.fromEntries(
      Object.entries(schema.properties).map(([controlId, control]) => [
        controlId,
        required.has(controlId)
          ? projectControlSchema(control)
          : { anyOf: [projectControlSchema(control), { type: "null" }] },
      ]),
    ),
  );
}

function projectControlSchema(
  control: CapabilityControl,
): Record<string, unknown> {
  if (control.type === "array") {
    return {
      type: "array",
      items: projectControlSchema(control.items),
      minItems: control.minItems,
      maxItems: control.maxItems,
    };
  }
  if (control.type === "string" && "enum" in control) {
    return { type: "string", enum: [...control.enum] };
  }
  return { ...control };
}

function normalizeNullableOptionalControls(
  value: unknown,
  schema: CapabilityControlsSchema,
): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const required = new Set(schema.required);
  return Object.fromEntries(
    Object.entries(record).filter(
      ([controlId, controlValue]) =>
        controlValue !== null ||
        required.has(controlId) ||
        !Object.hasOwn(schema.properties, controlId),
    ),
  );
}

function exactObject(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function literal(value: string): Record<string, unknown> {
  return { type: "string", const: value };
}

function slotId(index: number): string {
  return `invocation_${index + 1}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function refinementFailure(
  stage: "json_envelope" | "domain_parser",
  code: string,
  path: string,
) {
  return Object.freeze({
    ok: false as const,
    stage,
    issues: Object.freeze([refinementIssue(code, path)]),
  });
}

function refinementIssue(code: string, path: string) {
  return Object.freeze({
    code,
    path,
    message: "Capability controls are invalid.",
  });
}

function collectMaxLengthConstraints(
  value: unknown,
  path = "",
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectMaxLengthConstraints(entry, `${path}/${index}`),
    );
  }
  const record = asRecord(value);
  if (!record) return [];
  return [
    ...(Object.hasOwn(record, "maxLength")
      ? [{ keyword: "maxLength" as const, path: `${path}/maxLength` }]
      : []),
    ...Object.entries(record).flatMap(([key, entry]) =>
      collectMaxLengthConstraints(entry, `${path}/${escapeJsonPointer(key)}`),
    ),
  ];
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
