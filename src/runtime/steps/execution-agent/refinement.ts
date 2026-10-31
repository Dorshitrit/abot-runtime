import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
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
  CAPABILITY_CONTROLS_MODEL_STEP,
  materializeCapabilityControlsIfComplete,
  mergeCapabilityControls,
  type CapabilityControl,
  type CapabilityControls,
  type CapabilityControlsSchema,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import {
  ownsExecutionObservationControls,
  partitionExecutionCapabilityControls,
} from "./capability-controls-partition.js";
import { requiresExecutionOperationObjective } from "./capability-invocation-contract.js";
import { type ExecutionAgentCapabilityInvocation } from "./contracts.js";
import { buildExecutionControlsRefinementInstructions } from "./refinement-prompt.js";
import {
  buildExecutionControlsRefinementInput,
  executionRefinementSlotId as slotId,
  type PendingExecutionRefinement as PendingRefinement,
} from "./refinement-input.js";
import type { ExecutionAgentResolvedCapabilityInvocation } from "./contracts.js";
import { requiresControlsEvidenceSelection } from "./controls-evidence-contract.js";

export type RefinedExecutionCapabilityInvocation =
  ExecutionAgentResolvedCapabilityInvocation;

export type ExecutionCapabilityRefinementOutcome = Readonly<{
  disposition: "execute";
  invocations: readonly RefinedExecutionCapabilityInvocation[];
}>;

type RefineExecutionCapabilityInvocationsOptions = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  workingDirectory?: string;
  capabilities: readonly CapabilityDescriptor[];
  eligibleSessionArtifactPaths: readonly string[];
  invocations: readonly ExecutionAgentCapabilityInvocation[];
  steeringSnapshot: RequestSteeringSnapshot;
}>;

type ParsedRefinementEntry = Readonly<{
  index: number;
  disposition: "execute";
  controls: CapabilityControls;
}>;

function canExecuteWithSelectedControls(
  descriptor: CapabilityDescriptor,
  controls: CapabilityControls | undefined,
  guidance: string,
): boolean {
  if (controls === undefined) return false;
  if (ownsExecutionObservationControls(descriptor)) return true;
  return guidance.length === 0;
}

/**
 * Loads guidance for staged capabilities, then asks the same Execution Agent
 * to complete only their remaining controls. Ordinary observations already
 * received their guidance at decision and need no second model step. Identity,
 * selection controls, and ordering remain immutable. This is not a child-role call.
 */
export async function refineExecutionCapabilityInvocations(
  request: RequestExecutionScope,
  options: RefineExecutionCapabilityInvocationsOptions,
): Promise<ExecutionCapabilityRefinementOutcome> {
  if (options.invocations.length === 0) {
    throw new Error("execution_capability_refinement_empty");
  }
  const prepared = options.invocations.map((invocation, index) => {
    const descriptor = options.capabilities.find(
      ({ capabilityId }) => capabilityId === invocation.capabilityId,
    );
    if (!descriptor) {
      throw new Error("execution_capability_refinement_descriptor_missing");
    }
    const partition = partitionExecutionCapabilityControls(descriptor);
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
    if (
      requiresExecutionOperationObjective(
        partition.value,
        descriptor.requiresPayloadAuthoringObjective,
      ) &&
      !invocation.operationObjective
    ) {
      throw new Error("execution_capability_operation_objective_missing");
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
        ...new Set(
          prepared
            .filter(({ descriptor }) => !ownsExecutionObservationControls(descriptor))
            .map(({ descriptor }) => descriptor.capabilityId),
        ),
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
      if (canExecuteWithSelectedControls(entry.descriptor, entry.controls, guidance))
        return [];
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
      prepared.map(({ invocation, controls, descriptor }) =>
        freezeInvocation(invocation, controls!, descriptor),
      ),
    );
  }
  const format = createControlsRefinementFormat(pending);
  const instructions = buildExecutionControlsRefinementInstructions(
    pending.map(({ index, descriptor, guidance, partition }) => ({
      slot: slotId(index),
      capabilityId: descriptor.capabilityId,
      guidance,
      requiresEvidenceSelection: requiresControlsEvidenceSelection(partition),
    })),
  );
  const input = buildExecutionControlsRefinementInput(request, {
    ...options,
    pending,
    format,
    instructions,
  });
  const refined = await invokeStructuredModelStep({
    request,
    modelStep: CAPABILITY_CONTROLS_MODEL_STEP,
    format,
    messages: input.messages,
    contextCompaction: input.contextCompaction,
    boundSteeringVersion: options.steeringSnapshot.version,
    timeoutReason: "execution_capability_refinement_timeout",
    invalidOutputReason: "invalid_execution_capability_refinement",
    parse: (text) => parseControlsRefinement(text, pending),
  });
  const byIndex = new Map<number, CapabilityControls>();
  for (const entry of refined) {
    byIndex.set(entry.index, entry.controls);
  }
  return executeOutcome(
    prepared.map(({ index, invocation, controls, descriptor }) =>
      freezeInvocation(invocation, controls ?? byIndex.get(index)!, descriptor),
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
          exactObject({
            disposition: literal("execute"),
            controls: projectControlsSchema(partition.remainingSchema),
          }),
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
  descriptor: CapabilityDescriptor,
): RefinedExecutionCapabilityInvocation {
  if (!controls) throw new Error("execution_capability_controls_missing");
  return Object.freeze({
    capabilityId: invocation.capabilityId,
    ...(descriptor.requiresPayloadAuthoringObjective === true
      ? { authoringObjective: invocation.operationObjective! }
      : {}),
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
