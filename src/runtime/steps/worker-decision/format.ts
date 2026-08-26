import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  createStructuredDecisionEnvelopeSchema,
  structuredDecisionVariantSchemaPath,
} from "../../model/structured-decision-envelope.js";
import { isRoleCapabilityId } from "../../orchestration/role-calls/index.js";
import {
  WORKER_CAPABILITY_COUNT_MAX,
  normalizeWorkerCapabilityControlsSchema,
  partitionWorkerCapabilityControlsSchema,
  validateWorkerCapabilitySelectionControls,
  type WorkerCapabilityControl,
  type WorkerCapabilityControls,
  type WorkerCapabilityControlsPartition,
  type WorkerCapabilityControlsSchema,
  type WorkerCapabilityDescriptor,
} from "../../orchestration/worker-capabilities/index.js";
import {
  WORKER_CAPABILITY_INTENT_MAX_LENGTH,
  WORKER_RESULT_MAX_LENGTH,
  type WorkerDecisionPhase,
} from "./contracts.js";

type WorkerDecisionFormatCapability = Readonly<{
  capabilityId: string;
  effect: WorkerCapabilityDescriptor["effect"];
  controls: WorkerCapabilityControlsSchema;
  controlsPartition: WorkerCapabilityControlsPartition;
}>;

type WorkerCapabilitySelectionSchemaGroup = Readonly<{
  capabilities: readonly WorkerDecisionFormatCapability[];
  partition: WorkerCapabilityControlsPartition;
}>;

const WORKER_CAPABILITY_CLIENT_INTENT_DESCRIPTION =
  "Short client-facing statement of what will happen next. Presentation only; exclude sources, dependencies, controls, payload details, and execution instructions.";

export function createWorkerDecisionFormat(
  options: Readonly<{
    capabilities?: readonly WorkerCapabilityDescriptor[];
    maxBatchCapabilityExecutions?: number;
    allowSingleCapabilityInvocation?: boolean;
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
): ModelGatewayJsonSchemaFormat {
  if (
    options.capabilities !== undefined &&
    !Array.isArray(options.capabilities)
  ) {
    throw new Error("worker_capabilities_invalid");
  }
  const suppliedCapabilities = options.capabilities ?? [];
  const maxBatchCapabilityExecutions =
    options.maxBatchCapabilityExecutions ?? 0;
  const allowSingleCapabilityInvocation =
    options.allowSingleCapabilityInvocation !== false;
  const uniqueCapabilityIds = new Set(
    suppliedCapabilities.map((capability) => capability?.capabilityId),
  );
  if (
    suppliedCapabilities.length > WORKER_CAPABILITY_COUNT_MAX ||
    uniqueCapabilityIds.size !== suppliedCapabilities.length ||
    !Number.isInteger(maxBatchCapabilityExecutions) ||
    maxBatchCapabilityExecutions < 0
  ) {
    throw new Error("worker_capabilities_invalid");
  }
  const capabilities = Object.freeze(
    suppliedCapabilities.map((capability) => {
      if (
        typeof capability !== "object" ||
        capability === null ||
        !isRoleCapabilityId(capability.capabilityId) ||
        (capability.effect !== "observation" &&
          capability.effect !== "mutation" &&
          capability.effect !== "mixed")
      ) {
        throw new Error("worker_capabilities_invalid");
      }
      const controls = normalizeWorkerCapabilityControlsSchema(
        capability.controls,
      );
      if (!controls.ok) {
        throw new Error("worker_capabilities_invalid");
      }
      const controlsPartition = partitionWorkerCapabilityControlsSchema(
        controls.value,
        capability.selectionControlIds,
      );
      if (!controlsPartition.ok) {
        throw new Error("worker_capabilities_invalid");
      }
      return Object.freeze({
        capabilityId: capability.capabilityId,
        effect: capability.effect,
        controls: controls.value,
        controlsPartition: controlsPartition.value,
      });
    }),
  );
  const batchCapabilities = capabilities.filter(
    (capability) => capability.effect === "observation",
  );
  const pendingCapabilitySelection = options.pendingCapabilitySelection;
  const pendingCapabilityBatchSelection =
    options.pendingCapabilityBatchSelection;
  if (pendingCapabilitySelection && pendingCapabilityBatchSelection) {
    throw new Error("worker_pending_capability_selection_ambiguous");
  }
  if (
    pendingCapabilitySelection &&
    (!validPendingSelection(pendingCapabilitySelection, capabilities) ||
      pendingCapabilitySelection.intent.trim().length === 0 ||
      pendingCapabilitySelection.intent.length >
        WORKER_CAPABILITY_INTENT_MAX_LENGTH)
  ) {
    throw new Error("worker_pending_capability_selection_invalid");
  }
  if (
    pendingCapabilityBatchSelection &&
    (!Array.isArray(pendingCapabilityBatchSelection) ||
      pendingCapabilityBatchSelection.length < 2 ||
      pendingCapabilityBatchSelection.length > maxBatchCapabilityExecutions ||
      pendingCapabilityBatchSelection.some(
        (pending) =>
          !validPendingSelection(pending, batchCapabilities) ||
          !batchCapabilities.some(
            (capability) => capability.capabilityId === pending.capabilityId,
          ) ||
          pending.intent.trim().length === 0 ||
          pending.intent.length > WORKER_CAPABILITY_INTENT_MAX_LENGTH,
      ))
  ) {
    throw new Error("worker_pending_capability_batch_selection_invalid");
  }
  const decisionPhase: WorkerDecisionPhase =
    pendingCapabilitySelection || pendingCapabilityBatchSelection
      ? "capability_execution"
      : "capability_selection";
  const pendingSingleCapability = pendingCapabilitySelection
    ? capabilities.find(
        ({ capabilityId }) =>
          capabilityId === pendingCapabilitySelection.capabilityId,
      )!
    : undefined;
  const batchEnabled =
    maxBatchCapabilityExecutions >= 2 && batchCapabilities.length > 0;
  const singleSelectionGroups =
    groupCapabilitiesBySelectionSchema(capabilities);
  const batchSelectionGroups =
    groupCapabilitiesBySelectionSchema(batchCapabilities);
  const singleCapabilityVariants = !allowSingleCapabilityInvocation
    ? []
    : decisionPhase === "capability_selection"
      ? singleSelectionGroups.map((group) =>
          exactObject({
            action: literal("invoke_capability"),
            capabilityId: enumeration(
              group.capabilities.map(({ capabilityId }) => capabilityId),
            ),
            intent: capabilityIntentSelectionSchema(),
            ...(group.partition.selectionControlIds.length > 0
              ? {
                  selectionControls: projectControlsSchema(
                    group.partition.selectionSchema,
                  ),
                }
              : {}),
          }),
        )
      : pendingSingleCapability
        ? [
            exactObject({
              action: literal("invoke_capability"),
              controls: projectControlsSchema(
                pendingSingleCapability.controlsPartition.remainingSchema,
              ),
            }),
          ]
        : [];
  const pendingBatchCapabilities = pendingCapabilityBatchSelection?.map(
    ({ capabilityId }) =>
      batchCapabilities.find(
        (capability) => capability.capabilityId === capabilityId,
      )!,
  );
  const batchInvocationsSchema = pendingCapabilityBatchSelection
    ? exactObject(
        Object.fromEntries(
          pendingBatchCapabilities!.map((capability, index) => [
            workerCapabilityBatchExecutionSlotId(index),
            {
              ...exactObject({
                controls: projectControlsSchema(
                  capability.controlsPartition.remainingSchema,
                ),
              }),
              description: `Pending invocation ${index + 1} is frozen to capabilityId ${JSON.stringify(capability.capabilityId)} and any supplied selectionControls. Return only the remaining controls for this capability.`,
            },
          ]),
        ),
      )
    : {
        type: "array",
        minItems: 2,
        maxItems: maxBatchCapabilityExecutions,
        items: projectCapabilitySelectionItemSchema(batchSelectionGroups),
      };
  const variants = [
    exactObject({
      action: literal("return_result"),
    }),
    exactObject({
      action: literal("return_failure"),
      reason: boundedText(WORKER_RESULT_MAX_LENGTH),
    }),
    ...singleCapabilityVariants,
    ...(batchEnabled
      ? [
          exactObject({
            action: literal("invoke_capabilities"),
            invocations: batchInvocationsSchema,
          }),
        ]
      : []),
  ];
  const singleCapabilityVariantCount = allowSingleCapabilityInvocation
    ? singleCapabilityVariants.length
    : 0;
  const batchVariantIndex = singleCapabilityVariantCount + 2;
  return {
    type: "json_schema",
    name: "worker_decision",
    strict: true,
    postValidatedSchemaConstraints: [
      {
        keyword: "maxLength",
        path: `${structuredDecisionVariantSchemaPath(1, variants.length)}/properties/reason/maxLength`,
      },
      ...(allowSingleCapabilityInvocation && singleCapabilityVariants.length > 0
        ? decisionPhase === "capability_selection"
          ? singleSelectionGroups.flatMap((group, index) => {
              const variantPath = structuredDecisionVariantSchemaPath(
                2 + index,
                variants.length,
              );
              return [
                {
                  keyword: "maxLength" as const,
                  path: `${variantPath}/properties/intent/maxLength`,
                },
                ...collectControlMaxLengthConstraints(
                  group.partition.selectionSchema,
                  `${variantPath}/properties/selectionControls`,
                ),
              ];
            })
          : collectControlMaxLengthConstraints(
              pendingSingleCapability!.controlsPartition.remainingSchema,
              `${structuredDecisionVariantSchemaPath(2, variants.length)}/properties/controls`,
            )
        : []),
      ...(batchEnabled
        ? decisionPhase === "capability_selection"
          ? collectBatchSelectionMaxLengthConstraints({
              groups: batchSelectionGroups,
              basePath: `${structuredDecisionVariantSchemaPath(batchVariantIndex, variants.length)}/properties/invocations/items`,
            })
          : pendingBatchCapabilities!.flatMap((capability, index) => {
              const itemPath = `${structuredDecisionVariantSchemaPath(batchVariantIndex, variants.length)}/properties/invocations/properties/${workerCapabilityBatchExecutionSlotId(index)}/properties`;
              return collectControlMaxLengthConstraints(
                capability.controlsPartition.remainingSchema,
                `${itemPath}/controls`,
              );
            })
        : []),
    ],
    schema: createStructuredDecisionEnvelopeSchema(variants),
  };
}

export function workerCapabilityBatchExecutionSlotId(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("worker_capability_batch_execution_slot_invalid");
  }
  return `invocation_${index + 1}`;
}

function validPendingSelection(
  pending: Readonly<{
    capabilityId: string;
    intent: string;
    selectionControls?: WorkerCapabilityControls;
  }>,
  capabilities: readonly WorkerDecisionFormatCapability[],
): boolean {
  const capability = capabilities.find(
    ({ capabilityId }) => capabilityId === pending.capabilityId,
  );
  if (!capability) return false;
  const expectsSelectionControls =
    capability.controlsPartition.selectionControlIds.length > 0;
  if (
    Object.hasOwn(pending, "selectionControls") !== expectsSelectionControls
  ) {
    return false;
  }
  return validateWorkerCapabilitySelectionControls(
    capability.controlsPartition,
    pending.selectionControls ?? {},
  ).ok;
}

function groupCapabilitiesBySelectionSchema(
  capabilities: readonly WorkerDecisionFormatCapability[],
): readonly WorkerCapabilitySelectionSchemaGroup[] {
  const groups = new Map<
    string,
    {
      capabilities: WorkerDecisionFormatCapability[];
      partition: WorkerCapabilityControlsPartition;
    }
  >();
  for (const capability of capabilities) {
    const signature = JSON.stringify(
      capability.controlsPartition.selectionSchema,
    );
    const group = groups.get(signature) ?? {
      capabilities: [],
      partition: capability.controlsPartition,
    };
    group.capabilities.push(capability);
    groups.set(signature, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) =>
      Object.freeze({
        capabilities: Object.freeze([...group.capabilities]),
        partition: group.partition,
      }),
    ),
  );
}

function projectCapabilitySelectionItemSchema(
  groups: readonly WorkerCapabilitySelectionSchemaGroup[],
): Record<string, unknown> {
  const variants = groups.map((group) =>
    exactObject({
      capabilityId: enumeration(
        group.capabilities.map(({ capabilityId }) => capabilityId),
      ),
      intent: capabilityIntentSelectionSchema(),
      ...(group.partition.selectionControlIds.length > 0
        ? {
            selectionControls: projectControlsSchema(
              group.partition.selectionSchema,
            ),
          }
        : {}),
    }),
  );
  return variants.length === 1 ? variants[0]! : { anyOf: variants };
}

function collectBatchSelectionMaxLengthConstraints(
  params: Readonly<{
    groups: readonly WorkerCapabilitySelectionSchemaGroup[];
    basePath: string;
  }>,
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  return params.groups.flatMap((group, index) => {
    const itemPath =
      params.groups.length === 1
        ? params.basePath
        : `${params.basePath}/anyOf/${index}`;
    return [
      {
        keyword: "maxLength" as const,
        path: `${itemPath}/properties/intent/maxLength`,
      },
      ...collectControlMaxLengthConstraints(
        group.partition.selectionSchema,
        `${itemPath}/properties/selectionControls`,
      ),
    ];
  });
}

function projectControlsSchema(
  schema: WorkerCapabilityControlsSchema,
): Record<string, unknown> {
  const required = new Set(schema.required);
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(schema.properties).map(([controlId, control]) => [
        controlId,
        required.has(controlId)
          ? projectControlSchema(control)
          : {
              anyOf: [projectControlSchema(control), { type: "null" }],
            },
      ]),
    ),
    required: Object.keys(schema.properties),
    additionalProperties: false,
  };
}

function capabilityIntentSelectionSchema(): Record<string, unknown> {
  return {
    ...boundedText(WORKER_CAPABILITY_INTENT_MAX_LENGTH),
    description: WORKER_CAPABILITY_CLIENT_INTENT_DESCRIPTION,
  };
}

function projectControlSchema(
  control: WorkerCapabilityControl,
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

function collectControlMaxLengthConstraints(
  schema: WorkerCapabilityControlsSchema,
  basePath: string,
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  return Object.entries(schema.properties).flatMap(([controlId, control]) => {
    const propertyPath = `${basePath}/properties/${escapeJsonPointer(controlId)}${
      schema.required.includes(controlId) ? "" : "/anyOf/0"
    }`;
    if (control.type === "array") {
      return collectScalarMaxLengthConstraint(
        control.items,
        `${propertyPath}/items`,
      );
    }
    return collectScalarMaxLengthConstraint(control, propertyPath);
  });
}

function collectScalarMaxLengthConstraint(
  control: Exclude<WorkerCapabilityControl, { type: "array" }>,
  path: string,
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  return control.type === "string" && "maxLength" in control
    ? [{ keyword: "maxLength", path: `${path}/maxLength` }]
    : [];
}

function escapeJsonPointer(input: string): string {
  return input.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function exactObject(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function literal(value: string): Record<string, unknown> {
  return enumeration([value]);
}

function enumeration(values: readonly string[]): Record<string, unknown> {
  return { type: "string", enum: [...values] };
}

function boundedText(maxLength: number): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength,
  };
}
