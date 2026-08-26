import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import {
  createStructuredDecisionEnvelopeSchema,
  structuredDecisionVariantSchemaPath,
} from "../../model/structured-decision-envelope.js";
import {
  normalizeRoleCallWorkingDirectory,
  ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
} from "../../orchestration/role-calls/index.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import { createWorkerCapabilityScopeDecisionContract } from "../worker-capability-scope-decision.js";
import {
  isPlannerChildRoleId,
  PLANNER_CHILD_ROLE_IDS,
  PLANNER_OBJECTIVE_MAX_LENGTH,
  PLANNER_RESULT_MAX_LENGTH,
  type PlannerChildRoleId,
  type PlannerDecisionPlanContext,
} from "./contracts.js";
import {
  normalizePlannerDecisionPlanContext,
  plannerPlanAllowsInvocation,
} from "./plan.js";

export function createPlannerDecisionFormat(
  options: Readonly<{
    availableChildRoleIds?: readonly PlannerChildRoleId[];
    availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
    inheritedWorkingDirectory?: string;
    planContext?: PlannerDecisionPlanContext;
  }> = {},
): ModelGatewayJsonSchemaFormat {
  const availableChildRoleIds = normalizeAvailableChildRoleIds(
    options.availableChildRoleIds ?? PLANNER_CHILD_ROLE_IDS,
  );
  const availableWorkerCapabilityCatalog =
    options.availableWorkerCapabilityCatalog ?? [];
  const workerCapabilityScopeContract =
    createWorkerCapabilityScopeDecisionContract(
      availableWorkerCapabilityCatalog,
    );
  const planContext = options.planContext
    ? normalizePlannerDecisionPlanContext(options.planContext)
    : undefined;
  if (
    options.inheritedWorkingDirectory !== undefined &&
    normalizeRoleCallWorkingDirectory(options.inheritedWorkingDirectory) !==
      options.inheritedWorkingDirectory
  ) {
    throw new Error("planner_inherited_working_directory_invalid");
  }
  const workerAvailable = availableChildRoleIds.includes("worker");
  const workingDirectoryRequired =
    options.inheritedWorkingDirectory === undefined;
  const availableNonWorkerRoleIds = availableChildRoleIds.filter(
    (roleId): roleId is Exclude<PlannerChildRoleId, "worker"> =>
      roleId !== "worker",
  );
  const canInvoke =
    (workerAvailable || availableNonWorkerRoleIds.length > 0) &&
    plannerPlanAllowsInvocation(planContext);
  const selectingPlan = planContext?.mode === "select";
  const invokeVariantDefinitions = canInvoke
    ? [
        ...(workerAvailable
          ? [
              Object.freeze({
                worker: true,
                schema: invokeRoleSchema({
                  availableChildRoleIds: ["worker"],
                  workingDirectoryRequired,
                  ...(workerCapabilityScopeContract.schema
                    ? {
                        workerCapabilityScopeSchema:
                          workerCapabilityScopeContract.schema,
                      }
                    : {}),
                  planContext,
                }),
              }),
            ]
          : []),
        ...(availableNonWorkerRoleIds.length > 0
          ? [
              Object.freeze({
                worker: false,
                schema: invokeRoleSchema({
                  availableChildRoleIds: availableNonWorkerRoleIds,
                  planContext,
                }),
              }),
            ]
          : []),
      ]
    : [];
  const variants = [
    ...(!selectingPlan
      ? [
          exactObject({
            action: literal("return_result"),
            result: boundedText(PLANNER_RESULT_MAX_LENGTH),
          }),
        ]
      : []),
    exactObject({
      action: literal("return_failure"),
      reason: boundedText(PLANNER_RESULT_MAX_LENGTH),
    }),
    ...invokeVariantDefinitions.map(({ schema }) => schema),
  ];
  const failureVariantIndex = !selectingPlan ? 1 : 0;
  const invokeVariantStartIndex = failureVariantIndex + 1;

  return {
    type: "json_schema",
    name: "planner_decision",
    strict: true,
    postValidatedSchemaConstraints: [
      ...(!selectingPlan
        ? [
            {
              keyword: "maxLength" as const,
              path: `${structuredDecisionVariantSchemaPath(0, variants.length)}/properties/result/maxLength`,
            },
          ]
        : []),
      {
        keyword: "maxLength",
        path: `${structuredDecisionVariantSchemaPath(failureVariantIndex, variants.length)}/properties/reason/maxLength`,
      },
      ...invokeVariantDefinitions.flatMap(({ worker }, index) =>
        invokeRoleMaxLengthConstraints(
          planContext,
          variants.length,
          invokeVariantStartIndex + index,
          worker && workingDirectoryRequired,
        ),
      ),
    ],
    schema: createStructuredDecisionEnvelopeSchema(variants),
  };
}

function invokeRoleSchema(params: {
  availableChildRoleIds: readonly PlannerChildRoleId[];
  workingDirectoryRequired?: boolean;
  workerCapabilityScopeSchema?: Record<string, unknown>;
  planContext?: PlannerDecisionPlanContext;
}): Record<string, unknown> {
  return exactObject({
    action: literal("invoke_role"),
    roleId: {
      type: "string",
      enum: [...params.availableChildRoleIds],
    },
    ...(params.workingDirectoryRequired
      ? {
          workingDirectory: boundedText(ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH),
        }
      : {}),
    ...(params.workerCapabilityScopeSchema
      ? {
          workerCapabilityScope: params.workerCapabilityScopeSchema,
        }
      : {}),
    ...(params.planContext?.mode === "declare"
      ? {
          plan: exactObject({
            summary: boundedText(PLANNER_OBJECTIVE_MAX_LENGTH),
            items: {
              type: "array",
              minItems: 1,
              maxItems: params.planContext.maxItems,
              items: exactObject({
                title: boundedText(ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH),
                objective: boundedText(PLANNER_OBJECTIVE_MAX_LENGTH),
              }),
            },
          }),
          selectedItemIndexes: selectedItemIndexesSchema(
            params.planContext.maxItems,
          ),
        }
      : params.planContext?.mode === "extend"
        ? {
            extension: exactObject({
              items: {
                type: "array",
                minItems: 1,
                maxItems: params.planContext.maxItems,
                items: exactObject({
                  title: boundedText(ROLE_CALL_PLAN_ITEM_TITLE_MAX_LENGTH),
                  objective: boundedText(PLANNER_OBJECTIVE_MAX_LENGTH),
                }),
              },
            }),
            selectedItemIndexes: selectedItemIndexesSchema(
              params.planContext.maxItems,
            ),
          }
        : params.planContext?.mode === "select"
          ? {
              planItemIds: {
                type: "array",
                minItems: 1,
                maxItems: params.planContext.pendingItems.length,
                items: {
                  type: "string",
                  enum: params.planContext.pendingItems.map(
                    (item) => item.itemId,
                  ),
                },
              },
            }
          : { objective: boundedText(PLANNER_OBJECTIVE_MAX_LENGTH) }),
  });
}

function selectedItemIndexesSchema(maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems,
    items: {
      type: "integer",
      minimum: 0,
      maximum: Math.max(0, maxItems - 1),
    },
  };
}

function invokeRoleMaxLengthConstraints(
  planContext: PlannerDecisionPlanContext | undefined,
  variantCount: number,
  variantIndex: number,
  includeWorkingDirectory: boolean,
): Array<{ keyword: "maxLength"; path: string }> {
  const invokePath = structuredDecisionVariantSchemaPath(
    variantIndex,
    variantCount,
  );
  const workingDirectoryConstraints = includeWorkingDirectory
    ? [
        {
          keyword: "maxLength" as const,
          path: `${invokePath}/properties/workingDirectory/maxLength`,
        },
      ]
    : [];
  if (planContext?.mode === "select") {
    return workingDirectoryConstraints;
  }
  if (planContext?.mode === "extend") {
    return [
      ...workingDirectoryConstraints,
      {
        keyword: "maxLength",
        path: `${invokePath}/properties/extension/properties/items/items/properties/title/maxLength`,
      },
      {
        keyword: "maxLength",
        path: `${invokePath}/properties/extension/properties/items/items/properties/objective/maxLength`,
      },
    ];
  }
  if (planContext?.mode === "declare") {
    return [
      ...workingDirectoryConstraints,
      {
        keyword: "maxLength",
        path: `${invokePath}/properties/plan/properties/summary/maxLength`,
      },
      {
        keyword: "maxLength",
        path: `${invokePath}/properties/plan/properties/items/items/properties/title/maxLength`,
      },
      {
        keyword: "maxLength",
        path: `${invokePath}/properties/plan/properties/items/items/properties/objective/maxLength`,
      },
    ];
  }
  return [
    ...workingDirectoryConstraints,
    {
      keyword: "maxLength",
      path: `${invokePath}/properties/objective/maxLength`,
    },
  ];
}

export function normalizeAvailableChildRoleIds(
  values: readonly PlannerChildRoleId[],
): readonly PlannerChildRoleId[] {
  if (!Array.isArray(values)) {
    throw new Error("planner_available_child_roles_invalid");
  }
  const unique = new Set<PlannerChildRoleId>();
  for (const value of values) {
    if (!isPlannerChildRoleId(value) || unique.has(value)) {
      throw new Error("planner_available_child_roles_invalid");
    }
    unique.add(value);
  }
  return Object.freeze([...unique]);
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
  return { type: "string", enum: [value] };
}

function boundedText(maxLength: number): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength,
  };
}
